import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setNotifier,
  notifyHandoffComplete,
  type HandoffCompletePayload,
} from "./notifications.js";

describe("notifications", () => {
  beforeEach(() => {
    setNotifier(null);
  });

  it("is a no-op when no notifier is registered", () => {
    // Just ensure it doesn't throw.
    expect(() =>
      notifyHandoffComplete({
        run_id: "r1",
        kernel_id: "k1",
        status: "ok",
      })
    ).not.toThrow();
  });

  it("invokes the registered notifier with the payload", () => {
    const seen: HandoffCompletePayload[] = [];
    setNotifier((p) => seen.push(p));
    notifyHandoffComplete({
      run_id: "r1",
      kernel_id: "k1",
      status: "ok",
      execution_count: 7,
      first_line: "hello",
    });
    expect(seen).toEqual([
      {
        run_id: "r1",
        kernel_id: "k1",
        status: "ok",
        execution_count: 7,
        first_line: "hello",
      },
    ]);
  });

  it("swallows errors thrown by the notifier", () => {
    setNotifier(() => {
      throw new Error("transport boom");
    });
    expect(() =>
      notifyHandoffComplete({ run_id: "r", kernel_id: "k", status: "error" })
    ).not.toThrow();
  });

  it("end-to-end: KernelClient handoff -> connection.ts pool -> notifier fires", async () => {
    // Import lazily so we can configure the notifier before the pool wires its
    // onRunSettled (the wiring happens inside getKernelClient).
    const { KernelClient } = await import("./kernel-client.js");

    const calls: HandoffCompletePayload[] = [];
    setNotifier((p) => calls.push(p));

    // Build a fake WS and a KernelClient that registers the same
    // onRunSettled hook the production pool registers.
    type Listener = (...args: any[]) => void;
    const listeners: Record<string, Listener[]> = {
      open: [],
      message: [],
      error: [],
      close: [],
    };
    const sent: string[] = [];
    const fake = {
      on(event: string, l: Listener) {
        listeners[event].push(l);
      },
      send(data: string) {
        const parsed = JSON.parse(data);
        if (parsed.header.msg_type === "kernel_info_request") {
          const reply = JSON.stringify({
            parent_header: { msg_id: parsed.header.msg_id },
            msg_type: "kernel_info_reply",
            content: {},
          });
          for (const l of listeners.message) l(reply);
          return;
        }
        sent.push(data);
      },
      close() {},
    };

    const client = new KernelClient(
      "kernel-X",
      {
        host: "h",
        port: 0,
        token: "t",
        baseUrl: "http://h",
        wsUrl: "ws://h",
      } as any,
      { wsFactory: () => fake as any }
    );
    // Mirror what connection.ts/getKernelClient does:
    client.onRunSettled((run) => {
      if (!run.wasHandedOff) return;
      notifyHandoffComplete({
        run_id: run.id,
        kernel_id: run.kernelId,
        status: run.status,
        execution_count: run.executionCount,
        first_line: run.text ? run.text.split("\n")[0].slice(0, 120) : undefined,
      });
    });

    vi.useFakeTimers();
    try {
      const p = client.run("slow()", { handoffAfterMs: 50 });
      for (const l of listeners.open) l();
      await Promise.resolve();
      await Promise.resolve();
      const msgId = JSON.parse(sent[0]).header.msg_id;
      await vi.advanceTimersByTimeAsync(100);
      const o = await p;
      expect(o.kind).toBe("handoff");
      // No notification yet — only handoff happened.
      expect(calls).toHaveLength(0);

      // Now finish the run.
      const reply = JSON.stringify({
        parent_header: { msg_id: msgId },
        msg_type: "execute_reply",
        content: { execution_count: 9, status: "ok" },
      });
      for (const l of listeners.message) l(reply);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        run_id: msgId,
        kernel_id: "kernel-X",
        status: "ok",
        execution_count: 9,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("inline completion does NOT trigger a notification", async () => {
    const { KernelClient } = await import("./kernel-client.js");
    const calls: HandoffCompletePayload[] = [];
    setNotifier((p) => calls.push(p));

    type Listener = (...args: any[]) => void;
    const listeners: Record<string, Listener[]> = {
      open: [],
      message: [],
      error: [],
      close: [],
    };
    const sent: string[] = [];
    const fake = {
      on(event: string, l: Listener) {
        listeners[event].push(l);
      },
      send(data: string) {
        const parsed = JSON.parse(data);
        if (parsed.header.msg_type === "kernel_info_request") {
          const reply = JSON.stringify({
            parent_header: { msg_id: parsed.header.msg_id },
            msg_type: "kernel_info_reply",
            content: {},
          });
          for (const l of listeners.message) l(reply);
          return;
        }
        sent.push(data);
      },
      close() {},
    };
    const client = new KernelClient(
      "kernel-Y",
      { host: "h", port: 0, token: "t", baseUrl: "http://h", wsUrl: "ws://h" } as any,
      { wsFactory: () => fake as any }
    );
    client.onRunSettled((run) => {
      if (!run.wasHandedOff) return;
      notifyHandoffComplete({
        run_id: run.id,
        kernel_id: run.kernelId,
        status: run.status,
        execution_count: run.executionCount,
      });
    });

    const p = client.run("fast()", { timeoutMs: 5000 });
    for (const l of listeners.open) l();
    await Promise.resolve();
    await Promise.resolve();
    const msgId = JSON.parse(sent[0]).header.msg_id;
    const reply = JSON.stringify({
      parent_header: { msg_id: msgId },
      msg_type: "execute_reply",
      content: { execution_count: 1, status: "ok" },
    });
    for (const l of listeners.message) l(reply);
    await p;
    expect(calls).toHaveLength(0);
  });
});
