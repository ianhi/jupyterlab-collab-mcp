# Multi-Agent Testing Strategy

When testing multi-agent collaboration on notebooks, use a team of 4+ agents working simultaneously. The test should exercise:

1. **Cell ID stability**: Agents use `cell_id` (not indices) for all operations. One agent inserting cells mid-notebook must not break another agent's references.
2. **Cross-notebook operations**: Agents work across multiple notebooks using `copy_cells` and `move_cells`. E.g., one agent builds a data pipeline notebook while another builds a visualization notebook, and they share cells between them.
3. **Execute range**: Agents use `execute_range` to run multi-cell sections, not just single cells.
4. **Multi-plot cells**: Include cells that produce multiple matplotlib figures (subplots, figure galleries) to stress-test `max_images`/`include_images` context management. Agents should use `max_images=2` or `include_images=false` for plot-heavy cells to conserve context.
5. **Concurrent inserts**: Multiple agents inserting cells in the same notebook simultaneously — cell IDs prevent index collisions.
6. **Human-in-the-loop**: Human edits cells while agents work — agents should see focus-blocked errors and retry on different cells.

## Team Lead Role

The team lead acts as a **scientist/observer**, not a manager:
- **Setup**: Design the task, scaffold the notebook, create the team and tasks, launch all agents simultaneously
- **Observe**: Monitor the change log and notebook state for high-level issues
- **Don't micromanage**: Let agents coordinate organically through messaging and kernel variable polling. Don't direct traffic, assign work to idle agents, or prevent conflicts — conflicts are valuable for stress testing
- **Intervene only for systemic issues**: e.g., a shared kernel crash, a tool bug blocking all agents, or a fundamental misunderstanding of the task
- **Avoid rigid dependency graphs**: Use `blockedBy` sparingly or not at all. Let agents discover data availability themselves via `get_kernel_variables` and communicate through messages. Organic coordination surfaces real collaboration pain points that artificial sequencing hides.

## Test Phases

- Phase 1: Build & smoke test (`npm run build`, basic cell_id round-trip)
- Phase 2: Multi-agent collaboration (4+ agents, cell_id-based, parallel work)
- Phase 3: Collect agent feedback on the experience and suggestions for harder tasks

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
