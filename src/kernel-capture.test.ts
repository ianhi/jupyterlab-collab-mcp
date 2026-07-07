import { describe, it, expect, beforeEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import type { ExecutionResult } from "./helpers.js";

// Mock the connection module so we can drive executeCode's responses.
const executeCode = vi.fn<(k: string, c: string, t?: number) => Promise<ExecutionResult>>();
vi.mock("./connection.js", () => ({ executeCode: (...a: any[]) => executeCode(...(a as [string, string, number])) }));

import {
  ensureCaptureInstalled,
  retrieveCapturedRun,
  _resetCaptureState,
  _harnessSource,
} from "./kernel-capture.js";

function result(text: string): ExecutionResult {
  return { status: "ok", executionCount: 1, outputs: [], text, images: [], html: [] };
}

describe("kernel-capture orchestration", () => {
  beforeEach(() => {
    _resetCaptureState();
    executeCode.mockReset();
  });

  it("installs once and caches success", async () => {
    executeCode.mockResolvedValue(result("__MCP_CAPTURE__=ok\n"));
    expect(await ensureCaptureInstalled("k1")).toBe(true);
    expect(await ensureCaptureInstalled("k1")).toBe(true);
    // Second call is served from cache — no re-install.
    expect(executeCode).toHaveBeenCalledTimes(1);
  });

  it("caches unavailable (non-IPython kernel) and stops probing", async () => {
    executeCode.mockResolvedValue(result("__MCP_CAPTURE__=noipython\n"));
    expect(await ensureCaptureInstalled("k2")).toBe(false);
    expect(await ensureCaptureInstalled("k2")).toBe(false);
    expect(executeCode).toHaveBeenCalledTimes(1);
  });

  it("does not cache a transient install failure", async () => {
    executeCode.mockRejectedValueOnce(new Error("socket down"));
    expect(await ensureCaptureInstalled("k3")).toBe(false);
    // A later attempt should retry (not cached).
    executeCode.mockResolvedValueOnce(result("__MCP_CAPTURE__=ok"));
    expect(await ensureCaptureInstalled("k3")).toBe(true);
    expect(executeCode).toHaveBeenCalledTimes(2);
  });

  it("retrieves and parses a captured run", async () => {
    // Mark the kernel as capture-capable first.
    executeCode.mockResolvedValueOnce(result("__MCP_CAPTURE__=ok"));
    await ensureCaptureInstalled("k4");

    const rec = {
      run_id: "run-9",
      status: "ok",
      execution_count: 7,
      stdout: "done\n",
      stderr: "",
      result_repr: "42",
      duration_ms: 61000,
      truncated: false,
    };
    executeCode.mockResolvedValueOnce(result(`noise\n__MCP_REC__=${JSON.stringify(rec)}\n`));
    const got = await retrieveCapturedRun("k4", "run-9");
    expect(got).toEqual(rec);
  });

  it("returns undefined when the run was not captured (null record)", async () => {
    executeCode.mockResolvedValueOnce(result("__MCP_CAPTURE__=ok"));
    await ensureCaptureInstalled("k5");
    executeCode.mockResolvedValueOnce(result("__MCP_REC__=null"));
    expect(await retrieveCapturedRun("k5", "missing")).toBeUndefined();
  });

  it("skips retrieval entirely on a kernel known to lack capture", async () => {
    executeCode.mockResolvedValueOnce(result("__MCP_CAPTURE__=noipython"));
    await ensureCaptureInstalled("k6");
    executeCode.mockClear();
    expect(await retrieveCapturedRun("k6", "run-x")).toBeUndefined();
    // No execute attempted — we know capture isn't there.
    expect(executeCode).not.toHaveBeenCalled();
  });

  it("embeds configured limits into the harness source", () => {
    const src = _harnessSource();
    expect(src).toContain("__MCP_MAX_RUNS = 50");
    expect(src).toContain("pre_run_cell");
    expect(src).toContain("post_run_cell");
    expect(src).toContain("__MCP_CAPTURE__=ok");
  });

  it("harness is syntactically valid Python (guards against string-edit regressions)", () => {
    // Find a Python interpreter; skip cleanly if none is on PATH (e.g. minimal CI).
    const py = ["python3", "python"].find(
      (bin) => spawnSync(bin, ["--version"]).status === 0
    );
    if (!py) return;
    const check = spawnSync(py, ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
      input: _harnessSource(),
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });
});
