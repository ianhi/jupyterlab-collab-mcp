import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  KernelClient,
  MAX_RETAINED_RUNS,
  type KernelWebSocket,
  type RunOutcome,
} from "./kernel-client.js";
import type { JupyterConfig } from "./connection.js";

const config: JupyterConfig = {
  host: "localhost",
  port: 8888,
  token: "tok",
  baseUrl: "http://localhost:8888",
  wsUrl: "ws://localhost:8888",
};

type Listener = (...args: any[]) => void;

class FakeWebSocket implements KernelWebSocket {
  listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  sent: string[] = [];
  closed = false;
  /** When false, suppress the automatic kernel_info_reply (slow-joiner sim). */
  autoKernelInfo = true;
  kernelInfoRequests = 0;

  on(event: string, listener: Listener): void {
    this.listeners[event].push(listener);
  }

  send(data: string): void {
    // Emulate a live kernel: answer the readiness probe immediately and don't
    // count it as a user-visible send (keeps `sent`/`lastMsgId` assertions on
    // execute_requests intact).
    const parsed = JSON.parse(data);
    if (parsed.header.msg_type === "kernel_info_request") {
      this.kernelInfoRequests++;
      if (this.autoKernelInfo) {
        this.fireMessage({
          parent_header: { msg_id: parsed.header.msg_id },
          msg_type: "kernel_info_reply",
          content: {},
        });
      }
      return;
    }
    this.sent.push(data);
  }

  /** Manually answer the readiness probe (for tests with autoKernelInfo=false). */
  replyKernelInfo(): void {
    this.fireMessage({
      parent_header: { msg_id: "probe" },
      msg_type: "kernel_info_reply",
      content: {},
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.close) l();
  }

  // --- test helpers ---
  fireOpen(): void {
    for (const l of this.listeners.open) l();
  }
  fireMessage(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const l of this.listeners.message) l(data);
  }
  fireError(err: Error): void {
    for (const l of this.listeners.error) l(err);
  }
  fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.close) l();
  }

  /** Last execute_request msg_id, for replying with matching parent_header. */
  lastMsgId(): string {
    const last = this.sent[this.sent.length - 1];
    const parsed = JSON.parse(last);
    return parsed.header.msg_id;
  }

  allMsgIds(): string[] {
    return this.sent.map((s) => JSON.parse(s).header.msg_id);
  }
}

function replyOk(msgId: string, executionCount = 1) {
  return {
    parent_header: { msg_id: msgId },
    msg_type: "execute_reply",
    content: { execution_count: executionCount, status: "ok" },
  };
}

/** Helper: assert outcome is a result and return inner ExecutionResult. */
function expectResult(o: RunOutcome) {
  if (o.kind !== "result") {
    throw new Error(`expected result, got ${o.kind}`);
  }
  return o.result;
}

describe("KernelClient", () => {
  let fake: FakeWebSocket;
  let factoryCalls: number;

  beforeEach(() => {
    fake = new FakeWebSocket();
    factoryCalls = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeClient = (overrides: Partial<{ onClose: (r: string) => void }> = {}) =>
    new KernelClient("kernel-A", config, {
      wsFactory: () => {
        factoryCalls++;
        return fake;
      },
      onClose: overrides.onClose,
    });

  it("opens the WebSocket lazily on first run()", async () => {
    const client = makeClient();
    expect(factoryCalls).toBe(0);
    expect(client.isHealthy()).toBe(false);

    const runPromise = client.run("print(1)", { timeoutMs: 5000 });
    expect(factoryCalls).toBe(1);
    expect(client.isHealthy()).toBe(false);

    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.isHealthy()).toBe(true);
    expect(fake.sent.length).toBe(1);

    const msgId = fake.lastMsgId();
    fake.fireMessage(replyOk(msgId, 7));
    const outcome = await runPromise;
    const result = expectResult(outcome);
    expect(result.status).toBe("ok");
    expect(result.executionCount).toBe(7);
  });

  it("does not send execute_request until kernel_info_reply arrives (slow-joiner guard)", async () => {
    const client = makeClient();
    fake.autoKernelInfo = false;

    const runPromise = client.run("print(1)", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    // WS is open but the kernel hasn't acknowledged readiness: the run must be
    // held back, not fired into the dead window.
    expect(client.isHealthy()).toBe(false);
    expect(fake.sent.length).toBe(0);
    expect(fake.kernelInfoRequests).toBeGreaterThanOrEqual(1);

    // Kernel becomes ready -> run is now dispatched.
    fake.replyKernelInfo();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.isHealthy()).toBe(true);
    expect(fake.sent.length).toBe(1);

    fake.fireMessage(replyOk(fake.lastMsgId(), 1));
    const result = expectResult(await runPromise);
    expect(result.status).toBe("ok");
  });

  it("re-sends the kernel_info probe until the kernel replies", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    fake.autoKernelInfo = false;

    const runPromise = client.run("print(1)", { timeoutMs: 60_000 });
    runPromise.catch(() => {});
    fake.fireOpen();
    await Promise.resolve();
    expect(fake.kernelInfoRequests).toBe(1);

    // Probe was dropped (slow joiner) — the retry timer should re-send.
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.kernelInfoRequests).toBeGreaterThanOrEqual(2);

    fake.replyKernelInfo();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.isHealthy()).toBe(true);
    fake.fireMessage(replyOk(fake.lastMsgId(), 1));
    await runPromise;
  });

  it("reuses one WebSocket across multiple runs", async () => {
    const client = makeClient();
    const p1 = client.run("a", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p1;

    const p2 = client.run("b", { timeoutMs: 5000 });
    await Promise.resolve();
    await Promise.resolve();
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p2;

    expect(factoryCalls).toBe(1);
  });

  it("multiplexes two concurrent runs by msg_id", async () => {
    const client = makeClient();
    const r1 = client.run("one", { timeoutMs: 5000 });
    const r2 = client.run("two", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.sent.length).toBe(2);
    const [id1, id2] = fake.allMsgIds();
    expect(id1).not.toBe(id2);

    fake.fireMessage({
      parent_header: { msg_id: id2 },
      msg_type: "stream",
      content: { name: "stdout", text: "from-2" },
    });
    fake.fireMessage(replyOk(id2, 2));
    const res2 = expectResult(await r2);
    expect(res2.text).toBe("from-2");
    expect(res2.executionCount).toBe(2);

    fake.fireMessage({
      parent_header: { msg_id: id1 },
      msg_type: "stream",
      content: { name: "stdout", text: "from-1" },
    });
    fake.fireMessage(replyOk(id1, 1));
    const res1 = expectResult(await r1);
    expect(res1.text).toBe("from-1");
    expect(res1.executionCount).toBe(1);
  });

  it("ignores messages whose parent_header.msg_id is unknown", async () => {
    const client = makeClient();
    const p = client.run("x", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    fake.fireMessage({
      parent_header: { msg_id: "stranger" },
      msg_type: "execute_reply",
      content: { execution_count: 99, status: "ok" },
    });

    fake.fireMessage(replyOk(fake.lastMsgId(), 1));
    const res = expectResult(await p);
    expect(res.executionCount).toBe(1);
  });

  it("timeout rejects only the timed-out run, not concurrent ones", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const slow = client.run("sleep", { timeoutMs: 1000 });
    slow.catch(() => {});
    const fast = client.run("quick", { timeoutMs: 60_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const [idSlow, idFast] = fake.allMsgIds();

    await vi.advanceTimersByTimeAsync(1500);
    await expect(slow).rejects.toThrow(/timeout/i);

    expect(client.isHealthy()).toBe(true);
    fake.fireMessage(replyOk(idFast, 1));
    const fastRes = expectResult(await fast);
    expect(fastRes.status).toBe("ok");
    expect(idSlow).not.toBe(idFast);
  });

  it("WebSocket close rejects ALL in-flight runs", async () => {
    const client = makeClient();
    const a = client.run("a", { timeoutMs: 30_000 });
    const b = client.run("b", { timeoutMs: 30_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    fake.fireClose();
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(client.isHealthy()).toBe(false);
  });

  it("WebSocket error rejects all in-flight runs and fires onClose", async () => {
    const onClose = vi.fn();
    const client = makeClient({ onClose });
    const a = client.run("a", { timeoutMs: 30_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    fake.fireError(new Error("boom"));
    await expect(a).rejects.toThrow(/boom|ws error/);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.isHealthy()).toBe(false);
  });

  it("close() rejects in-flight runs and notifies onClose once", async () => {
    const onClose = vi.fn();
    const client = makeClient({ onClose });
    const r = client.run("x", { timeoutMs: 30_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    client.close("manual");
    await expect(r).rejects.toThrow(/manual/);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.isHealthy()).toBe(false);
  });

  it("isHealthy reflects lifecycle: false -> true -> false", async () => {
    const client = makeClient();
    expect(client.isHealthy()).toBe(false);
    const p = client.run("x", { timeoutMs: 30_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.isHealthy()).toBe(true);
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p;
    expect(client.isHealthy()).toBe(true);
    client.close();
    expect(client.isHealthy()).toBe(false);
  });

  it("updates lastActivityAt on send and receive", async () => {
    const client = makeClient();
    const before = client.lastActivityAt;
    await new Promise((r) => setTimeout(r, 2));
    const p = client.run("x", { timeoutMs: 30_000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const afterSend = client.lastActivityAt;
    expect(afterSend).toBeGreaterThanOrEqual(before);

    await new Promise((r) => setTimeout(r, 2));
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p;
    expect(client.lastActivityAt).toBeGreaterThanOrEqual(afterSend);
  });

  // ----- handoff behavior -----

  it("hands off when handoffAfterMs elapses; transitions to completed on reply", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const settled = vi.fn();
    client.onRunSettled(settled);

    const p = client.run("slow()", { handoffAfterMs: 1000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    const msgId = fake.lastMsgId();
    // Emit some partial output before handoff.
    fake.fireMessage({
      parent_header: { msg_id: msgId },
      msg_type: "stream",
      content: { name: "stdout", text: "partial..." },
    });

    await vi.advanceTimersByTimeAsync(1100);
    const outcome = await p;
    expect(outcome.kind).toBe("handoff");
    if (outcome.kind !== "handoff") throw new Error("unreachable");
    expect(outcome.partial.text).toBe("partial...");

    // Run record should be tracked, state=handed_off, NOT yet evicted.
    const run = client.getRun(outcome.runId);
    expect(run).toBeDefined();
    expect(run!.state).toBe("handed_off");
    expect(settled).not.toHaveBeenCalled();

    // More output, then completion.
    fake.fireMessage({
      parent_header: { msg_id: msgId },
      msg_type: "stream",
      content: { name: "stdout", text: " more" },
    });
    fake.fireMessage(replyOk(msgId, 3));

    const after = client.getRun(outcome.runId);
    expect(after!.state).toBe("completed");
    expect(after!.text).toBe("partial... more");
    expect(after!.executionCount).toBe(3);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0].id).toBe(outcome.runId);
  });

  it("resolves inline (kind=result) when run finishes before handoffAfterMs", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const p = client.run("fast()", { handoffAfterMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    fake.fireMessage(replyOk(fake.lastMsgId(), 4));
    const outcome = await p;
    expect(outcome.kind).toBe("result");
  });

  it("getRun returns the latest state through the lifecycle", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const p = client.run("x", { handoffAfterMs: 500 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const msgId = fake.lastMsgId();
    // After send, state should be "running".
    expect(client.getRun(msgId)!.state).toBe("running");
    await vi.advanceTimersByTimeAsync(600);
    const o = await p;
    expect(o.kind).toBe("handoff");
    expect(client.getRun(msgId)!.state).toBe("handed_off");
    fake.fireMessage(replyOk(msgId, 1));
    expect(client.getRun(msgId)!.state).toBe("completed");
  });

  it("onRunSettled fires exactly once per terminal run", async () => {
    const client = makeClient();
    const seen: string[] = [];
    client.onRunSettled((r) => seen.push(r.id));
    const p = client.run("x", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const id = fake.lastMsgId();
    fake.fireMessage(replyOk(id, 1));
    await p;
    // Extra spurious frame must not double-fire.
    fake.fireMessage(replyOk(id, 1));
    expect(seen).toEqual([id]);
  });

  it("unsubscribing onRunSettled stops further callbacks", async () => {
    const client = makeClient();
    const cb = vi.fn();
    const unsub = client.onRunSettled(cb);
    unsub();
    const p = client.run("x", { timeoutMs: 5000 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    fake.fireMessage(replyOk(fake.lastMsgId(), 1));
    await p;
    expect(cb).not.toHaveBeenCalled();
  });

  it("hasActiveRuns() reflects in-flight/handed_off runs (guards idle eviction)", async () => {
    const client = makeClient();
    expect(client.hasActiveRuns()).toBe(false);

    vi.useFakeTimers();
    const handoff = client.run("slow", { handoffAfterMs: 100 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const msgId = fake.lastMsgId();
    await vi.advanceTimersByTimeAsync(200);
    const o = await handoff;
    vi.useRealTimers();
    expect(o.kind).toBe("handoff");

    // Handed-off run is still in flight on the kernel → client is "active"
    // and must not be idle-evicted.
    expect(client.hasActiveRuns()).toBe(true);

    // Kernel finally responds → run settles → no longer active.
    fake.fireMessage(replyOk(msgId, 1));
    await Promise.resolve();
    expect(client.hasActiveRuns()).toBe(false);
  });

  it("retention: in-flight runs are never evicted, completed runs are LRU-capped", async () => {
    // We need to drive enough runs to exceed MAX_RETAINED_RUNS.
    // Use a fresh client and synchronously complete each run.
    const client = makeClient();
    // First, start one in-flight handed-off run that must never be evicted.
    vi.useFakeTimers();
    const handoff = client.run("slow", { handoffAfterMs: 100 });
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const handoffMsgId = fake.lastMsgId();
    await vi.advanceTimersByTimeAsync(200);
    const o = await handoff;
    expect(o.kind).toBe("handoff");
    vi.useRealTimers();

    // Now generate enough completed runs to exceed the LRU cap.
    for (let i = 0; i < MAX_RETAINED_RUNS + 5; i++) {
      const p = client.run(`c${i}`, { timeoutMs: 5000 });
      await Promise.resolve();
      await Promise.resolve();
      fake.fireMessage(replyOk(fake.lastMsgId(), i + 1));
      await p;
    }

    // In-flight handed_off run must still be retrievable.
    const stillThere = client.getRun(handoffMsgId);
    expect(stillThere).toBeDefined();
    expect(stillThere!.state).toBe("handed_off");

    // Completed runs are LRU-capped — total tracked at most MAX_RETAINED_RUNS + 1 in-flight.
    expect(client.recentRuns().length).toBeLessThanOrEqual(MAX_RETAINED_RUNS + 1);
  });
});
