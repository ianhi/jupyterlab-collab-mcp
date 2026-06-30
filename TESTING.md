# Multi-Agent Testing Strategy

When testing multi-agent collaboration on notebooks, use a team of 4+ agents working simultaneously. The test should exercise:

1. **Cell ID stability**: Agents use `cell_id` (not indices) for all operations. One agent inserting cells mid-notebook must not break another agent's references.
2. **Cross-notebook operations**: Agents work across multiple notebooks using `copy_cells` (and `copy_cells` with `delete_source=true` for moves). E.g., one agent builds a data pipeline notebook while another builds a visualization notebook, and they share cells between them.
3. **Execute range**: Agents use `execute_cell` with `end_index` or `cell_ids` to run multi-cell sections, not just single cells.
4. **Multi-plot cells**: Include cells that produce multiple matplotlib figures (subplots, figure galleries) to stress-test `max_images`/`include_images` context management. Agents should use `max_images=2` or `include_images=false` for plot-heavy cells to conserve context.
5. **Concurrent inserts**: Multiple agents inserting cells in the same notebook simultaneously — cell IDs prevent index collisions.
6. **Human-in-the-loop**: Human edits cells while agents work — agents should see focus-blocked errors and retry on different cells.

## Team Lead Role

The team lead acts as a **scientist/observer**, not a manager:
- **Setup**: Design the task, scaffold the notebook, create the team and tasks, launch all agents simultaneously
- **Observe**: Monitor the change log and notebook state for high-level issues
- **Don't micromanage**: Let agents coordinate organically through messaging and kernel variable polling. Don't direct traffic, assign work to idle agents, or prevent conflicts — conflicts are valuable for stress testing
- **Intervene only for systemic issues**: e.g., a shared kernel crash, a tool bug blocking all agents, or a fundamental misunderstanding of the task
- **Avoid rigid dependency graphs**: Use `blockedBy` sparingly or not at all. Let agents discover data availability themselves via `kernel_variables` and communicate through messages. Organic coordination surfaces real collaboration pain points that artificial sequencing hides.

## Test Phases

- Phase 1: Build & smoke test (`npm run build`, basic cell_id round-trip)
- Phase 2: Multi-agent collaboration (4+ agents, cell_id-based, parallel work)
- Phase 3: Collect agent feedback on the experience and suggestions for harder tasks

## Kernel cold-start race (ZMQ slow-joiner)

**The bug (fixed in `kernel-client.ts`):** `KernelClient` used to send the
`execute_request` the instant its WebSocket fired `"open"`. A kernel's ZMQ
iopub socket does not register a freshly-connected subscriber instantly, so an
`execute_request` sent inside that window is **silently dropped** — no
`execute_reply` ever comes back and the run hangs until its hard timeout
(default 30s). The fix gates `ensureOpen()` on a `kernel_info_request` /
`kernel_info_reply` round-trip (re-sent every 500ms until answered), so no
request is sent until the kernel proves its channels are live.

**Diagnostic signature** (how to confirm it's this and not a busy kernel):
- `execute_cell` / `execute_code` hangs, then fails with `Execution timeout`.
- `kernel status` shows **`idle`**, and the REST `last_activity` timestamp is
  **frozen at kernel-start time** — proof the kernel processed nothing, i.e.
  the request was dropped rather than slow.
- A `kernel restart` clears it (a fresh subscription that happens to win the race).

**It is a probabilistic race — do not expect to reproduce it on demand.** It
fires only when the first `execute_request` lands inside the brief subscribe
window, which needs cold conditions. In a warmed-up environment (kernelspecs
cached, sockets hot) ~12 varied attempts on the buggy build all passed. It is
most likely when:
- the kernel **already exists** (browser-opened, or a pre-existing session) and
  the MCP's **very first** `execute` is what lazily opens the KernelClient
  socket — this was the original `data_analysis.ipynb` repro;
- the JupyterLab/MCP processes have **just started** (first connection, cold OS
  socket/DNS state, system under load).
- `create_notebook` and a separate `open_notebook` are *less* prone because they
  tend to open/warm the socket a round-trip before the execute.

**How to test the fix:**
1. **Deterministic (authoritative):** the unit tests in `kernel-client.test.ts`
   — `does not send execute_request until kernel_info_reply arrives
   (slow-joiner guard)` and `re-sends the kernel_info probe until the kernel
   replies`. These lock the behavior in regardless of timing. Run
   `npx vitest run src/kernel-client.test.ts`.
2. **Live smoke (best-effort):** rebuild, **restart Claude Code** (the MCP
   server caches its code at startup — a rebuild alone does nothing for a live
   session), then run a burst of cold-start executions: create N notebooks and
   execute their first cell immediately; restart kernels then execute
   immediately; and `execute_code` on a pre-existing kernel as the first MCP
   action. All should return instantly. Absence of a hang is reassuring but not
   proof (you cannot prove a negative for a rare race) — rely on the unit tests.
3. **Reproduce the old bug (optional):** `git checkout main && npm run build`,
   restart Claude Code, repeat the burst, and watch for the timeout +
   frozen-`last_activity` signature. Then return to the fix branch, rebuild, and
   restart again to restore a good state.

## JupyterLab API Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List open notebooks |
| `/api/collaboration/session/{path}` | PUT | Request document session |
| `/api/collaboration/room/{room_id}` | WS | Yjs sync WebSocket |
| `/api/kernels/{id}/channels` | WS | Kernel execution |

## Connection Flow

1. `GET /api/sessions` → Find notebook path
2. `PUT /api/collaboration/session/{path}` → Get `fileId` and `sessionId`
3. Connect WebSocket to `/api/collaboration/room/json:notebook:{fileId}?sessionId=...`
4. Wait for y-websocket `sync` event
5. Access `doc.getArray("cells")` for notebook content

## Important Notes

- Always request a session before connecting to the room
- The `sessionId` must be passed as a query parameter
- Room ID format: `{format}:{type}:{fileId}` (e.g., `json:notebook:abc-123`)
- Don't URL-encode the room ID (colons must remain as-is)
- Cells are in `doc.getArray("cells")` as Y.Map objects with Y.Text for source
- Outputs from execution appear immediately in the browser

## Awareness / Collaboration

Claude appears as "Claude Code" in JupyterLab's collaborators panel with:
- Username: `claude-code`
- Display name: `Claude Code`
- Initials: `CC`
- Color: `#ff6b6b` (coral red)

The `get_user_focus` tool uses JupyterLab's awareness protocol to see which cell the user is currently editing.
