import type { ToolResult } from "../handler-types.js";

/**
 * On-demand best-practices guide for working with notebooks through this MCP.
 *
 * MCP servers cannot register Claude Code "skills" over the protocol, but a
 * tool whose output IS the guidance gives an equivalent result in any client:
 * the agent calls `notebook_guide` and the document lands in its context. The
 * guide is split into topic sections so callers can pull just the slice they
 * need instead of the whole thing every time.
 */

type Topic =
  | "overview"
  | "reading"
  | "editing"
  | "execution"
  | "collaboration"
  | "troubleshooting";

const SECTIONS: Record<Topic, string> = {
  overview: `## Orientation

This server's tools read, edit, and execute Jupyter notebooks in **two modes**,
chosen automatically:

- **Jupyter mode** — after \`connect_jupyter\`, edits sync live with the
  JupyterLab browser UI and a kernel is available for execution.
- **Filesystem mode** — without connecting, tools read/write \`.ipynb\` files
  on disk directly. No kernel, so execution tools are unavailable.

### Typical workflow
1. \`connect_jupyter\` for live sync and a kernel — or skip it to work on a
   \`.ipynb\` file on disk.
2. \`get_notebook_outline\` to orient, then \`get_notebook_content\` for the
   specific cells you need (don't dump the whole notebook).
3. Edit with \`insert_cell\` / \`update_cell\`, addressing cells by \`cell_id\`
   rather than index (see the \`editing\` topic).
4. Run with \`execute_cell\` (an existing notebook cell) or \`execute_code\`
   (throwaway code in the kernel).
5. Verify outputs; narrow large ones with \`filter_output\`.

### Two ways to run code
- \`execute_code\` — runs a string in the kernel. Does **not** touch the
  notebook. Use for scratch checks, inspecting state, or running source you
  already have.
- \`execute_cell\` — runs an existing cell *by index or id* and writes outputs
  back into the notebook. Use to (re)run cells the user can see.

The kernel keeps state between calls — load expensive data once and iterate
against the live objects rather than re-running setup each time (see the
\`execution\` topic).

Cell-indexed tools require the \`jupyter-collaboration\` server extension; if
it is absent they fail with a clear message (see the \`troubleshooting\` topic).
Kernel tools (\`execute_code\`, \`kernel\`) work without it.`,

  reading: `## Reading a notebook efficiently

- Start with \`get_notebook_outline\` to see structure (markdown headers + code
  cell previews) without pulling every line — especially for large notebooks.
- Then \`get_notebook_content\` with \`indices\`/\`cell_ids\`/\`start_index\`+\`end_index\`
  to read only the cells you need. Avoid dumping the whole notebook.
- \`search_notebook\` finds cells by content (regex); \`get_cell_outputs\` fetches
  outputs for specific cells without re-running them.
- For large outputs, read once then narrow with \`filter_output\`
  (grep/head/tail/max_lines) using the returned \`execution_id\`.`,

  editing: `## Editing cells

- \`insert_cell\` / \`update_cell\` for single edits; \`batch_insert_cells\` /
  \`batch_update_cells\` for several at once (fewer round-trips, and each batch
  is applied as a single update).
- **Prefer \`cell_id\` over \`index\` for multi-step edits.** Indices shift the
  moment you insert or delete a cell; ids are stable. Read ids from
  \`get_notebook_outline\`/\`get_notebook_content\`.
- \`insert_cell\`/\`update_cell\` accept \`execute=true\` to run immediately, and
  \`handoff_after_ms\` for long runs (see the \`execution\` topic).
- \`change_cell_type\` switches code↔markdown; \`copy_cells\` (with
  \`delete_source=true\`) moves cells, including across notebooks.
- Use \`update_cell\` with \`show_diff=true\` to preview the change inline.`,

  execution: `## Executing code

- \`execute_cell\` runs a notebook cell and stores its outputs; \`execute_code\`
  runs ad-hoc code in the kernel without modifying the notebook.
- **Long-running cells:** pass \`handoff_after_ms\` (e.g. 5000) plus a \`timeout\`
  larger than the expected runtime. If the run exceeds \`handoff_after_ms\` you
  get a \`run_id\` back immediately (you are not blocked) and a
  \`<channel source="jupyter">\` notification fires when it finishes; then call
  \`get_cell_run_output(run_id=...)\`, which returns the full final result
  directly. \`handoff_after_ms\` only controls when the \`run_id\` is handed back —
  it does not stop the run; \`timeout\` is what actually bounds it.
- **Big outputs:** an inline (non-handed-off) execute returns an
  \`execution_id\` — narrow it with \`filter_output\` instead of re-running. For a
  handed-off run, read the result straight from \`get_cell_run_output\` (no
  \`filter_output\` step needed).
- \`kernel(action="status"|"interrupt"|"restart")\` manages the kernel;
  \`kernel_variables\` lists/inspects defined variables.

### Persistent state — iterate, don't restart
The kernel is long-lived: variables, imports, and loaded data persist across
every \`execute_code\` / \`execute_cell\` call for the whole session. For
data-intensive work this beats running standalone scripts — load or compute the
expensive thing **once** (a large DataFrame, a fitted model, a parsed dataset),
then iterate with small \`execute_code\` calls against the live objects instead
of repeating setup. Use \`kernel_variables\` to see what's already defined, and
only \`kernel(action="restart")\` when you genuinely need a clean slate (it
discards all that state).`,

  collaboration: `## Sharing a notebook with a human

- A human may be editing live. \`get_user_focus\` shows which cell(s) collaborators
  are on — check before editing to avoid clobbering them.
- \`cell_locks(action="acquire"/"release"/"list")\` advisory-locks cells while you
  work on a multi-step change.
- \`get_notebook_changes\` / \`get_cell_history\` show recent edits;
  \`recover_cell\` restores a previous version of a cell.
- Before risky bulk edits, take a \`snapshot(action="save")\`; restore with
  \`snapshot(action="restore")\` if something goes wrong.`,

  troubleshooting: `## Troubleshooting

- **"Real-time collaboration is unavailable" on cell tools:** the server lacks
  the \`jupyter-collaboration\` extension, which cell-indexed tools require.
  Install it (\`pip install jupyter-collaboration\`) and restart JupyterLab, or
  fall back to kernel tools (\`execute_code\`) and filesystem mode.
  \`connect_jupyter\` warns up front when it's missing.
- **LSP features** (\`get_diagnostics\`, \`get_hover_info\`, \`rename_symbol\`) need
  \`jupyterlab-lsp\` + a Python language server; they degrade gracefully if absent.
- Hit a tool bug, hang, or have a suggestion? Use \`report_issue\` — it's
  persisted for the maintainers to review.`,
};

const TOPIC_ORDER: Topic[] = [
  "overview",
  "reading",
  "editing",
  "execution",
  "collaboration",
  "troubleshooting",
];

function isTopic(value: string): value is Topic {
  return (TOPIC_ORDER as string[]).includes(value);
}

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  notebook_guide: async (args) => {
    const { topic } = args as { topic?: string };

    const topics =
      topic && topic !== "all" && isTopic(topic) ? [topic] : TOPIC_ORDER;

    const body = topics.map((t) => SECTIONS[t]).join("\n\n");
    const header =
      topics.length === TOPIC_ORDER.length
        ? "# Working with notebooks via this MCP\n\n"
        : "";

    return { content: [{ type: "text", text: header + body }] };
  },
};
