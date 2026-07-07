/**
 * Kernel-side output capture — the sleep-proof recovery layer.
 *
 * The problem Phases 1–2 can't solve: if the host machine sleeps (or the
 * network hard-drops) while a handed-off run is in flight, the remote kernel
 * keeps computing, finishes, and streams its output to a socket nobody is
 * reading. Jupyter's iopub is pub/sub with no replay on reconnect, so that
 * output is gone — the MCP never received it, so there was nothing to persist
 * locally.
 *
 * The fix: have the *kernel* keep a copy of each slow run's output in its own
 * memory (NOT on its filesystem — no FS pollution, works on read-only /
 * restricted filesystems). After reconnecting, we recover it with a fresh
 * `execute_request` that reads the in-kernel buffer and prints it back as JSON
 * — a brand-new request/reply, immune to the iopub messages lost during the
 * outage.
 *
 * Design choices that keep this clean and low-footprint:
 *  - **Duration-gated**: only runs whose wall-time exceeds a threshold (~2s)
 *    are stored. Handed-off runs are by definition slow; fast internal MCP
 *    probes are never captured, so the small ring buffer never fills with
 *    noise. No code injection, no client/kernel coordination needed.
 *  - **Bounded in RAM**: a ring buffer of recent slow runs, each capped in
 *    size. If the kernel dies the capture is lost — but then the computation
 *    is gone anyway.
 *  - **IPython-only, bulletproof**: hooks are wrapped so a capture error can
 *    never break a user's cell; degrades to a no-op on non-IPython kernels.
 *
 * Fidelity: captures stdout, stderr (which includes IPython's rendered
 * traceback), and the repr of the cell's result value. Rich display outputs
 * (images/HTML) are NOT recovered by this layer — for those, run as a notebook
 * cell (output saved in the notebook) or write to a file.
 */
import { executeCode } from "./connection.js";

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Only capture runs that ran at least this long (ms). */
const MIN_CAPTURE_MS = envInt("JUPYTER_MCP_KERNEL_CAPTURE_MIN_MS", 2000);
/** Ring-buffer size: how many slow runs to retain in kernel memory. */
const MAX_CAPTURED = envInt("JUPYTER_MCP_KERNEL_CAPTURE_MAX_RUNS", 50);
/** Per-run character cap for captured stdout/stderr. */
const MAX_CHARS = envInt("JUPYTER_MCP_KERNEL_CAPTURE_MAX_CHARS", 1_000_000);

/** Recovered capture, shaped for reuse by get_cell_run_output. */
export interface CapturedRun {
  run_id: string;
  status: "ok" | "error";
  execution_count: number | null;
  stdout: string;
  stderr: string;
  result_repr: string | null;
  duration_ms: number;
  truncated: boolean;
}

/**
 * Python harness installed once per kernel. Idempotent (guarded by an attr on
 * the shell). Prints exactly one sentinel line so the caller knows whether
 * capture is available:
 *   __MCP_CAPTURE__=ok        capture active
 *   __MCP_CAPTURE__=noipython no IPython shell (capture unavailable)
 */
function harnessSource(): string {
  return `
try:
    from IPython.core.getipython import get_ipython as __mcp_gip
    __mcp_ip = __mcp_gip()
except Exception:
    __mcp_ip = None

if __mcp_ip is None:
    print("__MCP_CAPTURE__=noipython")
elif getattr(__mcp_ip, "_mcp_capture_installed", False):
    print("__MCP_CAPTURE__=ok")
else:
    import sys as __mcp_sys, io as __mcp_io, time as __mcp_time, traceback as __mcp_tb
    __MCP_MIN_S = ${(MIN_CAPTURE_MS / 1000).toFixed(3)}
    __MCP_MAX_RUNS = ${MAX_CAPTURED}
    __MCP_MAX_CHARS = ${MAX_CHARS}
    __mcp_store = {}      # msg_id -> record dict
    __mcp_order = []      # msg_id insertion order (ring buffer)
    __mcp_state = {}      # transient per-run capture state

    class __McpTee:
        def __init__(self, orig, buf):
            self._orig = orig; self._buf = buf
        def write(self, s):
            try: self._buf.write(s)
            except Exception: pass
            return self._orig.write(s)
        def flush(self):
            try: return self._orig.flush()
            except Exception: pass
        def __getattr__(self, name):
            return getattr(self._orig, name)

    def __mcp_msg_id():
        try:
            ph = getattr(__mcp_ip, "parent_header", None)
            if isinstance(ph, dict):
                if "msg_id" in ph: return ph["msg_id"]
                h = ph.get("header")
                if isinstance(h, dict): return h.get("msg_id")
            k = getattr(__mcp_ip, "kernel", None)
            if k is not None:
                gp = getattr(k, "get_parent", None)
                p = gp("shell") if callable(gp) else getattr(k, "_parent_header", None)
                if isinstance(p, dict):
                    h = p.get("header", p)
                    if isinstance(h, dict): return h.get("msg_id")
        except Exception:
            pass
        return None

    def __mcp_pre(info):
        try:
            out_buf = __mcp_io.StringIO(); err_buf = __mcp_io.StringIO()
            __mcp_state["t0"] = __mcp_time.time()
            __mcp_state["out_buf"] = out_buf
            __mcp_state["err_buf"] = err_buf
            __mcp_state["orig_out"] = __mcp_sys.stdout
            __mcp_state["orig_err"] = __mcp_sys.stderr
            __mcp_sys.stdout = __McpTee(__mcp_sys.stdout, out_buf)
            __mcp_sys.stderr = __McpTee(__mcp_sys.stderr, err_buf)
        except Exception:
            __mcp_state.clear()

    def __mcp_post(result):
        try:
            if "orig_out" in __mcp_state:
                __mcp_sys.stdout = __mcp_state["orig_out"]
                __mcp_sys.stderr = __mcp_state["orig_err"]
        except Exception:
            pass
        try:
            t0 = __mcp_state.get("t0")
            dur = (__mcp_time.time() - t0) if t0 else 0.0
            if dur < __MCP_MIN_S:
                __mcp_state.clear(); return
            mid = __mcp_msg_id()
            if not mid:
                __mcp_state.clear(); return
            out = __mcp_state.get("out_buf")
            err = __mcp_state.get("err_buf")
            out_s = out.getvalue() if out else ""
            err_s = err.getvalue() if err else ""
            err_in_exec = getattr(result, "error_in_exec", None)
            status = "error" if err_in_exec is not None else "ok"
            # Capture the traceback explicitly rather than relying on it being
            # teed through sys.stderr (routing varies across IPython versions).
            if err_in_exec is not None:
                try:
                    tb_txt = "".join(__mcp_tb.format_exception(
                        type(err_in_exec), err_in_exec, err_in_exec.__traceback__))
                except Exception:
                    tb_txt = repr(err_in_exec)
                if tb_txt and tb_txt not in err_s:
                    err_s = (err_s + "\\n" + tb_txt) if err_s else tb_txt
            trunc = False
            if len(out_s) > __MCP_MAX_CHARS:
                out_s = out_s[:__MCP_MAX_CHARS] + "\\n… [truncated]"; trunc = True
            if len(err_s) > __MCP_MAX_CHARS:
                err_s = err_s[:__MCP_MAX_CHARS] + "\\n… [truncated]"; trunc = True
            rrepr = None
            try:
                rv = getattr(result, "result", None)
                if rv is not None: rrepr = repr(rv)[:__MCP_MAX_CHARS]
            except Exception:
                rrepr = "<unreprable result>"
            ec = getattr(getattr(result, "info", None), "execution_count", None)
            if ec is None:
                ec = getattr(__mcp_ip, "execution_count", None)
            rec = {"run_id": mid, "status": status, "execution_count": ec,
                   "stdout": out_s, "stderr": err_s, "result_repr": rrepr,
                   "duration_ms": int(dur * 1000), "truncated": trunc}
            if mid in __mcp_store:
                try: __mcp_order.remove(mid)
                except ValueError: pass
            __mcp_store[mid] = rec
            __mcp_order.append(mid)
            while len(__mcp_order) > __MCP_MAX_RUNS:
                old = __mcp_order.pop(0)
                __mcp_store.pop(old, None)
        except Exception:
            pass
        finally:
            __mcp_state.clear()

    def __mcp_capture_get(mid):
        return __mcp_store.get(mid)

    __mcp_ip.__dict__["__mcp_capture_get"] = __mcp_capture_get
    __mcp_ip.events.register("pre_run_cell", __mcp_pre)
    __mcp_ip.events.register("post_run_cell", __mcp_post)
    __mcp_ip._mcp_capture_installed = True
    print("__MCP_CAPTURE__=ok")
`.trim();
}

/**
 * Off-switch: set JUPYTER_MCP_DISABLE_KERNEL_CAPTURE=1 to disable all
 * kernel-side instrumentation (e.g. on kernels where any injected code is
 * unwelcome). Capture is a recovery safety net, never required for correctness.
 */
function captureDisabled(): boolean {
  const v = process.env.JUPYTER_MCP_DISABLE_KERNEL_CAPTURE;
  return v === "1" || v === "true";
}

/** kernelId -> install state, so we install at most once per kernel. */
const installState = new Map<string, "ok" | "unavailable">();
/** In-flight installs, so concurrent handoffs don't each issue a harness run. */
const installInFlight = new Map<string, Promise<boolean>>();

/**
 * Ensure the capture harness is installed on `kernelId`. Idempotent, cached,
 * and de-duplicated across concurrent callers. Returns true if capture is
 * active, false if unavailable (non-IPython kernel or install failed). Never
 * throws.
 *
 * Callers on the handoff hot path should NOT await this — fire it so the
 * harness `execute_request` is queued on the socket just ahead of the user's
 * run (the kernel is single-threaded FIFO, so the harness installs first and
 * the user run is captured), without adding any latency to the user run.
 */
export async function ensureCaptureInstalled(kernelId: string): Promise<boolean> {
  if (captureDisabled()) return false;
  const cached = installState.get(kernelId);
  if (cached) return cached === "ok";
  const pending = installInFlight.get(kernelId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await executeCode(kernelId, harnessSource(), 15000, { storeHistory: false });
      const ok = res.text.includes("__MCP_CAPTURE__=ok");
      installState.set(kernelId, ok ? "ok" : "unavailable");
      return ok;
    } catch {
      // Don't cache transient failures — a later run may succeed.
      return false;
    } finally {
      installInFlight.delete(kernelId);
    }
  })();
  installInFlight.set(kernelId, p);
  return p;
}

/**
 * Recover a captured run from the kernel's in-memory buffer via a fresh
 * execute (works after a reconnect). Returns undefined if capture is
 * unavailable, the run wasn't captured, or anything goes wrong.
 */
export async function retrieveCapturedRun(
  kernelId: string,
  runId: string
): Promise<CapturedRun | undefined> {
  if (captureDisabled()) return undefined;
  // Reading the buffer only makes sense if the harness is present. If it was
  // never installed on this kernel, there is nothing to recover.
  if (installState.get(kernelId) === "unavailable") return undefined;
  const literal = JSON.stringify(runId); // safe Python string literal (JSON ⊂ Python)
  const code =
    `import json as __mcp_json\n` +
    `try:\n` +
    `    __mcp_rec = get_ipython().__dict__.get("__mcp_capture_get", lambda _: None)(${literal})\n` +
    `except Exception:\n` +
    `    __mcp_rec = None\n` +
    `print("__MCP_REC__=" + __mcp_json.dumps(__mcp_rec))`;
  try {
    const res = await executeCode(kernelId, code, 15000, { storeHistory: false });
    const marker = "__MCP_REC__=";
    const idx = res.text.lastIndexOf(marker);
    if (idx === -1) return undefined;
    const json = res.text.slice(idx + marker.length).trim();
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as CapturedRun;
  } catch {
    return undefined;
  }
}

/** Test-only: reset the per-kernel install cache. */
export function _resetCaptureState(): void {
  installState.clear();
  installInFlight.clear();
}

/** Test-only: the installed harness source (for syntax validation). */
export function _harnessSource(): string {
  return harnessSource();
}
