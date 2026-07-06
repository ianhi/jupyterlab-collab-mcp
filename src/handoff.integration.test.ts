/**
 * End-to-end handoff integration test.
 *
 * Drives the same code path as the live MCP server for the handoff
 * lifecycle: kernel doesn't reply within handoff_after_ms, the agent
 * gets back a run_id, the kernel eventually finishes, the notifier
 * fires with the right meta, and get_cell_run_output returns the
 * final formatted ExecutionResult.
 *
 * Scope: covers (a) handler-level handoff handle and (b) notifier +
 * get_cell_run_output. The y-doc cell backfill path is exercised in
 * src/handoff-targets.test.ts — wiring a Y.Doc through a stubbed
 * connectToNotebook + listNotebookSessions adds significant fixture
 * weight for marginal coverage given the per-helper test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  KernelClient,
  type KernelWebSocket,
} from "./kernel-client.js";
import {
  setJupyterConfig,
  kernelClients,
  executeCodeWithHandoff,
  type JupyterConfig,
} from "./connection.js";
import { setNotifier, type HandoffCompletePayload } from "./notifications.js";
import { handlers as executeHandlers } from "./handlers/execute.js";

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
    const parsed = JSON.parse(data);
    if (parsed.header.msg_type === "kernel_info_request") {
      this.fireMessage({
        parent_header: { msg_id: parsed.header.msg_id },
        msg_type: "kernel_info_reply",
        content: {},
      });
      return;
    }
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.close) l();
  }
  fireOpen(): void {
    for (const l of this.listeners.open) l();
  }
  fireMessage(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const l of this.listeners.message) l(data);
  }
  lastMsgId(): string {
    const last = this.sent[this.sent.length - 1];
    return JSON.parse(last).header.msg_id;
  }
}

const config: JupyterConfig = {
  host: "localhost",
  port: 8888,
  token: "tok",
  baseUrl: "http://localhost:8888",
  wsUrl: "ws://localhost:8888",
};

describe("handoff integration", () => {
  let fake: FakeWebSocket;

  beforeEach(() => {
    setJupyterConfig(config);
    setNotifier(null);
    kernelClients.clear();
    fake = new FakeWebSocket();
  });

  afterEach(() => {
    setJupyterConfig(null);
    setNotifier(null);
    kernelClients.clear();
  });

  it(
    "hands off, notifies on completion, get_cell_run_output returns final result",
    async () => {
      const kernelId = "kernel-1";

      // Seed the pool with a KernelClient that uses our FakeWebSocket.
      const client = new KernelClient(kernelId, config, {
        wsFactory: () => fake,
      });
      kernelClients.set(kernelId, client);

      // Wire the same onRunSettled callback the live pool uses by reaching
      // into the runtime: easiest is to register notifier directly and let
      // the connection-side onRunSettled drive it. But because we bypassed
      // getKernelClient (which is what attaches the onRunSettled callback),
      // we re-attach it here mirroring the production wiring.
      const { notifyHandoffComplete } = await import("./notifications.js");
      const { backfillRunOutputs } = await import("./handoff-targets.js");
      client.onRunSettled((run) => {
        if (!run.wasHandedOff) return;
        try {
          backfillRunOutputs(run);
        } catch {
          // ignored
        }
        notifyHandoffComplete({
          run_id: run.id,
          kernel_id: run.kernelId,
          status: run.status,
          execution_count: run.executionCount,
          first_line: run.text
            ? run.text.split("\n")[0].slice(0, 120)
            : undefined,
        });
      });

      const notifications: HandoffCompletePayload[] = [];
      setNotifier((p) => {
        notifications.push(p);
      });

      // Start a run with a 50ms handoff and the kernel deliberately silent.
      const outcomePromise = executeCodeWithHandoff(kernelId, "long_job()", {
        handoffAfterMs: 50,
      });
      // Open the WS.
      fake.fireOpen();
      // Yield to let the ensureOpen promise resolve and the request go out.
      await Promise.resolve();
      await Promise.resolve();
      // Emit a bit of partial output before the handoff.
      const msgId = fake.lastMsgId();
      fake.fireMessage({
        parent_header: { msg_id: msgId },
        msg_type: "stream",
        content: { name: "stdout", text: "starting..." },
      });

      // Wait for the handoff timer.
      await new Promise((r) => setTimeout(r, 80));
      const outcome = await outcomePromise;
      expect(outcome.kind).toBe("handoff");
      if (outcome.kind !== "handoff") throw new Error("unreachable");
      expect(outcome.runId).toBe(msgId);
      expect(outcome.partial.text).toBe("starting...");

      // Notifier should NOT have fired yet — the run is still alive.
      expect(notifications).toHaveLength(0);

      // Kernel eventually finishes.
      fake.fireMessage({
        parent_header: { msg_id: msgId },
        msg_type: "stream",
        content: { name: "stdout", text: " done\n" },
      });
      fake.fireMessage({
        parent_header: { msg_id: msgId },
        msg_type: "execute_reply",
        content: { execution_count: 9, status: "ok" },
      });

      // Notifier fires with the right meta.
      expect(notifications).toHaveLength(1);
      expect(notifications[0].run_id).toBe(msgId);
      expect(notifications[0].kernel_id).toBe(kernelId);
      expect(notifications[0].status).toBe("ok");
      expect(notifications[0].execution_count).toBe(9);
      expect(notifications[0].first_line).toBe("starting... done");

      // get_cell_run_output returns the final formatted result.
      const handler = executeHandlers["get_cell_run_output"];
      expect(handler).toBeDefined();
      const out = await handler({ run_id: msgId });
      const text = (out.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain(`Run ${msgId}`);
      expect(text).toContain("completed");
      expect(text).toContain("starting... done");
    },
    10_000
  );
});
