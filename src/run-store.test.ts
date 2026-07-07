import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Run } from "./kernel-client.js";

/**
 * run-store reads its config from env at import time, so each test sets env,
 * resets the module registry, and dynamically imports a fresh instance.
 */

let tmpBase: string;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-" + Math.random().toString(36).slice(2),
    kernelId: "kernel-1",
    state: "completed",
    startedAt: 1000,
    completedAt: 2000,
    outputs: [],
    executionCount: 1,
    status: "ok",
    text: "hello world",
    images: [],
    html: [],
    wasHandedOff: true,
    ...overrides,
  };
}

async function freshStore(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return import("./run-store.js");
}

/** Wait for fire-and-forget writes + bounds enforcement to settle. */
async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

describe("run-store", () => {
  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "run-store-test-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("persists a run and loads it back", async () => {
    const dir = path.join(tmpBase, "a");
    const store = await freshStore({ JUPYTER_MCP_RUN_STORE_DIR: dir });
    const run = makeRun({ text: "the answer is 42" });
    store.persistRun(run);
    await flush();

    const loaded = await store.loadPersistedRun(run.id);
    expect(loaded).toBeDefined();
    expect(loaded!.text).toBe("the answer is 42");
    expect(loaded!.state).toBe("completed");
    expect(loaded!.status).toBe("ok");
    expect(loaded!.truncated).toBe(false);
  });

  it("returns undefined for an unknown run id", async () => {
    const dir = path.join(tmpBase, "b");
    const store = await freshStore({ JUPYTER_MCP_RUN_STORE_DIR: dir });
    expect(await store.loadPersistedRun("nope")).toBeUndefined();
  });

  it("truncates oversized text and flags it", async () => {
    const dir = path.join(tmpBase, "c");
    const store = await freshStore({
      JUPYTER_MCP_RUN_STORE_DIR: dir,
      JUPYTER_MCP_RUN_STORE_MAX_TEXT: "100",
    });
    const run = makeRun({ text: "x".repeat(5000) });
    store.persistRun(run);
    await flush();

    const loaded = await store.loadPersistedRun(run.id);
    expect(loaded!.truncated).toBe(true);
    expect(loaded!.text.length).toBeLessThan(5000);
    expect(loaded!.text).toContain("truncated for storage");
  });

  it("caps the number of retained files (LRU by mtime)", async () => {
    const dir = path.join(tmpBase, "d");
    const store = await freshStore({
      JUPYTER_MCP_RUN_STORE_DIR: dir,
      JUPYTER_MCP_RUN_STORE_MAX_FILES: "3",
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const run = makeRun();
      ids.push(run.id);
      store.persistRun(run);
      await flush(); // distinct mtimes + ordered bounds enforcement
    }
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(3);
    // The most-recently-written run must survive.
    expect(await store.loadPersistedRun(ids[5])).toBeDefined();
    // The oldest must have been evicted.
    expect(await store.loadPersistedRun(ids[0])).toBeUndefined();
  });

  it("sweeps records older than the TTL", async () => {
    const dir = path.join(tmpBase, "e");
    const store = await freshStore({
      JUPYTER_MCP_RUN_STORE_DIR: dir,
      JUPYTER_MCP_RUN_STORE_TTL_MS: "60000", // 60s
    });
    const old = makeRun();
    store.persistRun(old);
    await flush();

    // Deterministically age the old file well past the TTL.
    const oldFile = path.join(dir, `${old.id}.json`);
    const past = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(oldFile, past, past);

    // A second write triggers bounds enforcement, which sweeps the expired one.
    const fresh = makeRun();
    store.persistRun(fresh);
    await flush();

    expect(await store.loadPersistedRun(old.id)).toBeUndefined();
    expect(await store.loadPersistedRun(fresh.id)).toBeDefined();
  });
});
