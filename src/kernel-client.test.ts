import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { KernelClient, type KernelWebSocket } from "./kernel-client.js";
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

  on(event: string, listener: Listener): void {
    this.listeners[event].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
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

    const runPromise = client.run("print(1)", 5000);
    // Factory called immediately; socket not yet open.
    expect(factoryCalls).toBe(1);
    expect(client.isHealthy()).toBe(false);

    fake.fireOpen();
    // Allow microtask queue (open handler -> waiters.resolve -> run continues).
    await Promise.resolve();
    await Promise.resolve();
    expect(client.isHealthy()).toBe(true);
    expect(fake.sent.length).toBe(1);

    const msgId = fake.lastMsgId();
    fake.fireMessage(replyOk(msgId, 7));
    const result = await runPromise;
    expect(result.status).toBe("ok");
    expect(result.executionCount).toBe(7);
  });

  it("reuses one WebSocket across multiple runs", async () => {
    const client = makeClient();
    const p1 = client.run("a", 5000);
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p1;

    const p2 = client.run("b", 5000);
    await Promise.resolve();
    await Promise.resolve();
    fake.fireMessage(replyOk(fake.lastMsgId()));
    await p2;

    expect(factoryCalls).toBe(1);
  });

  it("multiplexes two concurrent runs by msg_id", async () => {
    const client = makeClient();
    const r1 = client.run("one", 5000);
    const r2 = client.run("two", 5000);
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.sent.length).toBe(2);
    const [id1, id2] = fake.allMsgIds();
    expect(id1).not.toBe(id2);

    // Reply to r2 first; r1 must still be pending.
    fake.fireMessage({
      parent_header: { msg_id: id2 },
      msg_type: "stream",
      content: { name: "stdout", text: "from-2" },
    });
    fake.fireMessage(replyOk(id2, 2));
    const res2 = await r2;
    expect(res2.text).toBe("from-2");
    expect(res2.executionCount).toBe(2);

    // Now reply to r1.
    fake.fireMessage({
      parent_header: { msg_id: id1 },
      msg_type: "stream",
      content: { name: "stdout", text: "from-1" },
    });
    fake.fireMessage(replyOk(id1, 1));
    const res1 = await r1;
    expect(res1.text).toBe("from-1");
    expect(res1.executionCount).toBe(1);
  });

  it("ignores messages whose parent_header.msg_id is unknown", async () => {
    const client = makeClient();
    const p = client.run("x", 5000);
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();

    // Broadcast frame from another session — must not affect our run.
    fake.fireMessage({
      parent_header: { msg_id: "stranger" },
      msg_type: "execute_reply",
      content: { execution_count: 99, status: "ok" },
    });

    fake.fireMessage(replyOk(fake.lastMsgId(), 1));
    const res = await p;
    expect(res.executionCount).toBe(1);
  });

  it("timeout rejects only the timed-out run, not concurrent ones", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const slow = client.run("sleep", 1000);
    // Attach a no-op catch now so the eventual timeout rejection isn't
    // reported as unhandled before `expect(...).rejects` subscribes.
    slow.catch(() => {});
    const fast = client.run("quick", 60_000);
    fake.fireOpen();
    await Promise.resolve();
    await Promise.resolve();
    const [idSlow, idFast] = fake.allMsgIds();

    // Advance past the slow run's timeout.
    await vi.advanceTimersByTimeAsync(1500);
    await expect(slow).rejects.toThrow(/timeout/i);

    // Client must still be healthy and able to resolve the other run.
    expect(client.isHealthy()).toBe(true);
    fake.fireMessage(replyOk(idFast, 1));
    const fastRes = await fast;
    expect(fastRes.status).toBe("ok");
    // sanity: idSlow !== idFast
    expect(idSlow).not.toBe(idFast);
  });

  it("WebSocket close rejects ALL in-flight runs", async () => {
    const client = makeClient();
    const a = client.run("a", 30_000);
    const b = client.run("b", 30_000);
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
    const a = client.run("a", 30_000);
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
    const r = client.run("x", 30_000);
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
    const p = client.run("x", 30_000);
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
    // Force a tiny clock advance.
    await new Promise((r) => setTimeout(r, 2));
    const p = client.run("x", 30_000);
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
});
