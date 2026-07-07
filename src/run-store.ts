/**
 * Bounded, disk-backed cache of handed-off run outputs.
 *
 * Why: handed-off `run_id`s are handed back to the caller with the implied
 * contract "fetch the result later". But the in-memory `Run` record lives only
 * inside a pooled `KernelClient` and is dropped on idle eviction, MCP restart,
 * TTL/LRU eviction, or a dropped socket. This store is the durable fallback:
 * `get_cell_run_output` reads from here when the in-memory record is gone.
 *
 * Scope & limits:
 *  - Only *handed-off* runs are persisted (a caller only holds ids for those).
 *  - One JSON file per run, keyed by run_id, under a single flat directory.
 *  - Bounded three ways so it can never grow without limit:
 *      • per-run size  (text truncated, images capped) — one huge output can't
 *        blow the budget;
 *      • max file count (LRU by mtime);
 *      • max total bytes (LRU by mtime);
 *      • TTL sweep on first use.
 *  - Writes are best-effort and fire-and-forget: a failed persist never breaks
 *    execution. Reads tolerate missing/corrupt files.
 *
 * Location: the MCP *host* (not the kernel FS) — this is a local recovery cache
 * for outputs the server already received. It does NOT survive the host
 * machine sleeping mid-run (the server received nothing to persist); that case
 * is handled by the kernel-side capture layer (kernel-capture.ts).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { NotebookOutput } from "./helpers.js";
import type { Run, RunState } from "./kernel-client.js";

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Directory holding per-run JSON files. Overridable for tests / custom setups. */
const STORE_DIR =
  process.env.JUPYTER_MCP_RUN_STORE_DIR ||
  path.join(os.tmpdir(), "jupyterlab-collab-mcp-runs");

/** Max characters of run text kept per run (older overflow is dropped, marked). */
const MAX_TEXT_CHARS = envInt("JUPYTER_MCP_RUN_STORE_MAX_TEXT", 512 * 1024);
/** Max images kept per run (base64 payloads are large). */
const MAX_IMAGES = envInt("JUPYTER_MCP_RUN_STORE_MAX_IMAGES", 20);
/** Max number of run files retained (LRU by mtime). */
const MAX_FILES = envInt("JUPYTER_MCP_RUN_STORE_MAX_FILES", 1000);
/** Max total bytes across all run files (LRU by mtime). */
const MAX_TOTAL_BYTES = envInt("JUPYTER_MCP_RUN_STORE_MAX_BYTES", 64 * 1024 * 1024);
/** Records older than this are swept. Default 24h — deliberately longer than
 *  in-memory retention so disk is a genuine fallback. */
const TTL_MS = envInt("JUPYTER_MCP_RUN_STORE_TTL_MS", 24 * 60 * 60 * 1000);

/** Serializable snapshot of a run, sufficient to reconstruct its output. */
export interface PersistedRun {
  id: string;
  kernelId: string;
  state: RunState;
  startedAt: number;
  completedAt?: number;
  status: "ok" | "error";
  executionCount: number | null;
  text: string;
  images: { data: string; mimeType: string }[];
  html: string[];
  outputs: NotebookOutput[];
  errorMessage?: string;
  wasHandedOff: boolean;
  /** True if text/images/outputs were capped to fit the per-run size budget. */
  truncated: boolean;
  /** When this snapshot was written (ms epoch). */
  persistedAt: number;
}

let dirEnsured = false;
async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await fs.mkdir(STORE_DIR, { recursive: true });
  dirEnsured = true;
}

function runIdToFile(runId: string): string {
  // run_id is a kernel-generated uuid/msg_id; still sanitize to be safe.
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(STORE_DIR, `${safe}.json`);
}

/** Cap a run snapshot to the per-run size budget, flagging truncation. */
function capForStorage(run: Run): PersistedRun {
  let truncated = false;
  let text = run.text ?? "";
  if (text.length > MAX_TEXT_CHARS) {
    const dropped = text.length - MAX_TEXT_CHARS;
    text = text.slice(0, MAX_TEXT_CHARS) + `\n… [${dropped} chars truncated for storage]`;
    truncated = true;
  }
  let images = run.images ?? [];
  if (images.length > MAX_IMAGES) {
    images = images.slice(0, MAX_IMAGES);
    truncated = true;
  }
  // `outputs` can also carry large base64 payloads; if we truncated the flat
  // text/images, drop the redundant structured outputs rather than double-count.
  const outputs = truncated ? [] : run.outputs ?? [];
  return {
    id: run.id,
    kernelId: run.kernelId,
    state: run.state,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status: run.status,
    executionCount: run.executionCount,
    text,
    images,
    html: run.html ?? [],
    outputs,
    errorMessage: run.errorMessage,
    wasHandedOff: run.wasHandedOff,
    truncated,
    persistedAt: Date.now(),
  };
}

/**
 * Persist a run snapshot (fire-and-forget). Call on handoff and again on
 * settle so the on-disk copy reflects the latest known state.
 */
export function persistRun(run: Run): void {
  void persistRunAsync(run).catch(() => {
    // Best-effort: never let a persistence failure surface to the caller.
  });
}

async function persistRunAsync(run: Run): Promise<void> {
  await ensureDir();
  const rec = capForStorage(run);
  const file = runIdToFile(run.id);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec), "utf8");
  await fs.rename(tmp, file); // atomic replace
  await enforceBounds();
}

/** Load a persisted run by id, or undefined if absent/unreadable. */
export async function loadPersistedRun(runId: string): Promise<PersistedRun | undefined> {
  try {
    const raw = await fs.readFile(runIdToFile(runId), "utf8");
    return JSON.parse(raw) as PersistedRun;
  } catch {
    return undefined;
  }
}

let boundsInFlight: Promise<void> | null = null;
/** Coalesced bounds enforcement: TTL sweep + file-count + total-bytes LRU. */
function enforceBounds(): Promise<void> {
  if (boundsInFlight) return boundsInFlight;
  boundsInFlight = enforceBoundsInner().finally(() => {
    boundsInFlight = null;
  });
  return boundsInFlight;
}

async function enforceBoundsInner(): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(STORE_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  const entries: { file: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const file = path.join(STORE_DIR, name);
    try {
      const st = await fs.stat(file);
      // TTL sweep.
      if (now - st.mtimeMs > TTL_MS) {
        await fs.rm(file, { force: true });
        continue;
      }
      entries.push({ file, mtime: st.mtimeMs, size: st.size });
    } catch {
      // ignore races
    }
  }
  // Oldest first, so we evict from the front.
  entries.sort((a, b) => a.mtime - b.mtime);
  let totalBytes = entries.reduce((s, e) => s + e.size, 0);
  let count = entries.length;
  for (const e of entries) {
    if (count <= MAX_FILES && totalBytes <= MAX_TOTAL_BYTES) break;
    try {
      await fs.rm(e.file, { force: true });
      count--;
      totalBytes -= e.size;
    } catch {
      // ignore races
    }
  }
}

/** Test-only: absolute path of the store directory. */
export function _storeDir(): string {
  return STORE_DIR;
}
