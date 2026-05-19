/**
 * Push-notification plumbing for handed-off runs.
 *
 * The MCP server sends `notifications/claude/channel` messages so the
 * agent gets re-prompted when a previously handed-off run terminates,
 * instead of having to poll get_cell_run_output.
 *
 * This module is a thin level of indirection so `connection.ts` can
 * register a notifier without importing the MCP `Server` directly
 * (which would create an init-order cycle: `index.ts` constructs the
 * server, but `connection.ts` is imported by handlers).
 */

export interface HandoffCompletePayload {
  run_id: string;
  kernel_id: string;
  status: "ok" | "error";
  execution_count?: number | null;
  first_line?: string;
}

type Notifier = (p: HandoffCompletePayload) => void;

let notifier: Notifier | null = null;

export function setNotifier(fn: Notifier | null): void {
  notifier = fn;
}

export function notifyHandoffComplete(p: HandoffCompletePayload): void {
  if (!notifier) return;
  try {
    notifier(p);
  } catch {
    // A misbehaving transport must not poison execution.
  }
}
