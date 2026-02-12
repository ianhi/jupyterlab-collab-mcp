import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  resolveCellId,
} from "../helpers.js";
import {
  readNotebook,
  resolveNotebookPath,
  writeNotebook,
} from "../notebook-fs.js";
import {
  isJupyterConnected,
  lspStatus,
  getLanguageServerForFile,
  listNotebookSessions,
  connectToNotebook,
  executeCode,
  apiFetch,
  type NotebookSession,
} from "../connection.js";
import { renameSymbol } from "../rename.js";
import {
  generateListVariablesCode,
  generateInspectVariablesCode,
  formatBasicOutput,
  formatSchemaOutput,
  formatFullOutput,
  formatOneInspection,
} from "../variable-inspector.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "get_kernel_status": async (args) => {
    const { path } = args as { path: string };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      return {
        content: [
          {
            type: "text",
            text: `No active kernel for ${path}. Use open_notebook to start a kernel.`,
          },
        ],
      };
    }

    const response = await apiFetch(`/api/kernels/${session.kernelId}`);
    if (!response.ok) {
      throw new Error(`Failed to get kernel status: ${response.statusText}`);
    }

    const kernel = await response.json();
    const lines = [
      `Kernel status for ${path}:`,
      `  Status: ${kernel.execution_state || "unknown"}`,
      `  Name: ${kernel.name}`,
      `  ID: ${kernel.id}`,
    ];
    if (kernel.connections !== undefined) {
      lines.push(`  Connections: ${kernel.connections}`);
    }
    if (kernel.last_activity) {
      lines.push(`  Last activity: ${kernel.last_activity}`);
    }
    return {
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  },

  "get_kernel_variables": async (args) => {
    const {
      path,
      detail = "basic",
      filter: filterName,
      include_private: includePrivate = false,
      max_variables: maxVariables = 50,
      max_items: maxItems = 20,
    } = args as {
      path: string;
      detail?: string;
      filter?: string;
      include_private?: boolean;
      max_variables?: number;
      max_items?: number;
    };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      return {
        content: [
          {
            type: "text",
            text: `No active kernel for ${path}. Use open_notebook to start a kernel.`,
          },
        ],
      };
    }

    const code = generateListVariablesCode({
      detail,
      maxVariables,
      maxItems,
      filterName,
      includePrivate,
    });

    const result = await executeCode(session.kernelId, code);

    if (result.status === "error") {
      return {
        content: [
          {
            type: "text",
            text: `Failed to inspect kernel variables: ${result.text}`,
          },
        ],
      };
    }

    try {
      const parsed = JSON.parse(result.text.trim());

      let text: string;
      if (detail === "schema") {
        text = formatSchemaOutput(path, parsed as string[]);
      } else if (detail === "full") {
        text = formatFullOutput(path, parsed as Record<string, unknown>[]);
      } else {
        text = formatBasicOutput(path, parsed as { name: string; type: string; repr: string }[], filterName);
      }

      return { content: [{ type: "text", text }] };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Could not parse kernel variables. Raw output: ${result.text}`,
          },
        ],
      };
    }
  },

  "inspect_variable": async (args) => {
    const {
      path,
      names,
      max_items: maxItems = 20,
    } = args as {
      path: string;
      names: string[];
      max_items?: number;
    };

    if (!names || names.length === 0) {
      throw new Error("'names' must be a non-empty array of variable names.");
    }
    if (names.length > 20) {
      throw new Error("Maximum 20 variable names per call.");
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      return {
        content: [
          {
            type: "text",
            text: `No active kernel for ${path}. Use open_notebook to start a kernel.`,
          },
        ],
      };
    }

    const code = generateInspectVariablesCode({ names, maxItems });
    const result = await executeCode(session.kernelId, code);

    if (result.status === "error") {
      return {
        content: [
          {
            type: "text",
            text: `Failed to inspect variables: ${result.text}`,
          },
        ],
      };
    }

    try {
      const inspections = JSON.parse(result.text.trim()) as Record<string, unknown>[];
      const parts = inspections.map((info) => formatOneInspection(info));
      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Could not parse inspection results. Raw output: ${result.text}`,
          },
        ],
      };
    }
  },

  "interrupt_kernel": async (args) => {
    const { path } = args as { path: string };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(`No active kernel for ${path}. Nothing to interrupt.`);
    }

    const response = await apiFetch(`/api/kernels/${session.kernelId}/interrupt`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Failed to interrupt kernel: ${response.statusText}`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Interrupted kernel for ${path}. Execution stopped but variables preserved.`,
        },
      ],
    };
  },

  "restart_kernel": async (args) => {
    const { path } = args as { path: string };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(`No active kernel for ${path}. Use open_notebook to start a kernel.`);
    }

    const response = await apiFetch(`/api/kernels/${session.kernelId}/restart`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Failed to restart kernel: ${response.statusText}`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Restarted kernel for ${path}. All variables cleared. Kernel is ready for new execution.`,
        },
      ],
    };
  },

  "get_diagnostics": async (args) => {
    const { path, cell_index, cell_id } = args as {
      path: string;
      cell_index?: number;
      cell_id?: string;
    };

    // Helper to collect sources from cells
    let cellSources: { index: number; source: string }[];
    let sessionForKernel: NotebookSession | undefined;

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      let resolvedCellIndex = cell_index;
      if (cell_id !== undefined) {
        if (cell_index !== undefined) throw new Error("Specify either 'cell_index' or 'cell_id', not both.");
        resolvedCellIndex = resolveCellId(notebook.cells, cell_id);
      }

      if (resolvedCellIndex !== undefined) {
        if (resolvedCellIndex < 0 || resolvedCellIndex >= notebook.cells.length) {
          throw new Error(`Invalid cell index ${resolvedCellIndex}. Notebook has ${notebook.cells.length} cells.`);
        }
        cellSources = [{ index: resolvedCellIndex, source: extractSource(notebook.cells[resolvedCellIndex]) }];
      } else {
        cellSources = [];
        for (let i = 0; i < notebook.cells.length; i++) {
          if (getCellType(notebook.cells[i]) === "code") {
            cellSources.push({ index: i, source: extractSource(notebook.cells[i]) });
          }
        }
      }
    } else {
      const sessions = await listNotebookSessions();
      sessionForKernel = sessions.find((s) => s.path === path);

      const { doc } = await connectToNotebook(path, sessionForKernel?.kernelId);
      const cells = doc.getArray("cells");

      let resolvedCellIndex = cell_index;
      if (cell_id !== undefined) {
        if (cell_index !== undefined) throw new Error("Specify either 'cell_index' or 'cell_id', not both.");
        resolvedCellIndex = resolveCellId(cells, cell_id);
      }

      if (resolvedCellIndex !== undefined) {
        if (resolvedCellIndex < 0 || resolvedCellIndex >= cells.length) {
          throw new Error(`Invalid cell index ${resolvedCellIndex}. Notebook has ${cells.length} cells.`);
        }
        cellSources = [{ index: resolvedCellIndex, source: extractSource(cells.get(resolvedCellIndex) as any) }];
      } else {
        cellSources = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = cells.get(i) as Y.Map<any>;
          if (getCellType(cell) === "code") {
            cellSources.push({ index: i, source: extractSource(cell) });
          }
        }
      }

      // Try LSP first if available
      const languageServer = getLanguageServerForFile(path);
      if (lspStatus.available && languageServer) {
        // Fall through to syntax check for now
      }
    }

    const indicesToCheck = cellSources.map((c) => c.index);

    // Use ruff via uvx for fast, comprehensive diagnostics (no kernel needed)
    const diagnostics: { cell: number; line: number; column?: number; code: string; message: string; severity: string }[] = [];
    let diagnosticMethod: "ruff" | "syntax" | "none" = "none";

    for (const { index: idx, source } of cellSources) {
      if (!source.trim()) continue;

      try {
        // Run ruff via uvx with JSON output
        const { spawn } = await import("child_process");
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn("uvx", [
            "ruff", "check", "--stdin-filename", `cell_${idx}.py`,
            "--output-format", "json", "--select", "E,F", "--ignore", "F401", "-"
          ], { timeout: 10000 });

          let stdout = "";
          let stderr = "";

          proc.stdin.write(source);
          proc.stdin.end();

          proc.stdout.on("data", (data: any) => { stdout += data; });
          proc.stderr.on("data", (data: any) => { stderr += data; });

          proc.on("close", (code: any) => {
            // ruff returns non-zero if issues found, that's fine
            resolve(stdout);
          });

          proc.on("error", (err: any) => {
            reject(err);
          });
        });

        diagnosticMethod = "ruff";
        if (result.trim()) {
          const issues = JSON.parse(result);
          for (const issue of issues) {
            const severity = issue.code?.startsWith("E") ? "error" : "warning";
            diagnostics.push({
              cell: idx,
              line: issue.location?.row || 1,
              column: issue.location?.column,
              code: issue.code || "",
              message: issue.message || "Unknown issue",
              severity,
            });
          }
        }
      } catch (e: any) {
        // If uvx/ruff not available, fall back to basic syntax check
        if (e.code === "ENOENT" || e.message?.includes("spawn")) {
          // uvx not found - try kernel-based syntax check
          if (sessionForKernel?.kernelId) {
            const checkCode = `
try:
    compile(${JSON.stringify(source)}, '<cell ${idx}>', 'exec')
    print("OK")
except SyntaxError as e:
    print(f"SYNTAX:{e.lineno or 1}:{e.msg}")
`;
            try {
              const kernelResult = await executeCode(sessionForKernel.kernelId, checkCode, 5000);
              diagnosticMethod = "syntax";
              const output = kernelResult.text.trim();
              if (output.startsWith("SYNTAX:")) {
                const parts = output.slice(7).split(":");
                diagnostics.push({
                  cell: idx,
                  line: parseInt(parts[0], 10) || 1,
                  code: "E999",
                  message: parts.slice(1).join(":"),
                  severity: "error",
                });
              }
            } catch {
              // Kernel check failed too
            }
          }
        }
      }
    }

    // Build result message based on what diagnostic method was available
    if (diagnosticMethod === "none") {
      return {
        content: [
          {
            type: "text",
            text: `Could not run diagnostics for ${path}. Install uv (https://docs.astral.sh/uv/) or open the notebook to enable kernel-based syntax checking.`,
          },
        ],
      };
    }

    const methodNote = diagnosticMethod === "syntax"
      ? " (syntax only - install uv for full diagnostics)"
      : "";

    if (diagnostics.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No issues found in ${indicesToCheck.length} code cell(s) of ${path}${methodNote}`,
          },
        ],
      };
    }

    const report = diagnostics
      .map((d) => {
        const loc = d.column ? `line ${d.line}:${d.column}` : `line ${d.line}`;
        const code = d.code ? `[${d.code}] ` : "";
        return `  Cell ${d.cell}, ${loc}: ${code}${d.message}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${diagnostics.length} issue(s) in ${path}:\n\n${report}`,
        },
      ],
    };
  },

  "get_hover_info": async (args) => {
    const { path, cell_index, line, character } = args as {
      path: string;
      cell_index: number;
      line: number;
      character: number;
    };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    if (cell_index < 0 || cell_index >= cells.length) {
      throw new Error(`Invalid cell index ${cell_index}. Notebook has ${cells.length} cells.`);
    }

    const cell = cells.get(cell_index) as Y.Map<any>;
    const source = extractSource(cell);
    const lines = source.split("\n");

    if (line < 0 || line >= lines.length) {
      throw new Error(`Invalid line ${line}. Cell has ${lines.length} lines.`);
    }

    // Extract the word at the position
    const lineText = lines[line];
    let wordStart = character;
    let wordEnd = character;

    // Find word boundaries
    while (wordStart > 0 && /\w/.test(lineText[wordStart - 1])) wordStart--;
    while (wordEnd < lineText.length && /\w/.test(lineText[wordEnd])) wordEnd++;

    const word = lineText.slice(wordStart, wordEnd);

    if (!word) {
      return {
        content: [{ type: "text", text: "No identifier at this position" }],
      };
    }

    // Try LSP first if available
    const languageServer = getLanguageServerForFile(path);
    if (lspStatus.available && languageServer) {
      // Would use textDocument/hover here
      // Fall through to kernel introspection for now
    }

    // Fallback: Kernel introspection
    if (!session?.kernelId) {
      return {
        content: [
          {
            type: "text",
            text: `No kernel available. Cannot get info for "${word}".`,
          },
        ],
      };
    }

    // Build context by including earlier cells
    const contextCells: string[] = [];
    for (let i = 0; i <= cell_index; i++) {
      const c = cells.get(i) as Y.Map<any>;
      if (getCellType(c) === "code") {
        contextCells.push(extractSource(c));
      }
    }

    // Use Python introspection
    const inspectCode = `
${contextCells.join("\n")}

# Introspection
_target = ${word}
import inspect
_result_parts = []
_result_parts.append(f"**{type(_target).__name__}**: \`{_target.__name__ if hasattr(_target, '__name__') else repr(_target)[:100]}\`")
if hasattr(_target, '__doc__') and _target.__doc__:
    _doc = _target.__doc__.strip()
    if len(_doc) > 500:
        _doc = _doc[:500] + "..."
    _result_parts.append(f"\\n{_doc}")
if callable(_target):
    try:
        _sig = str(inspect.signature(_target))
        _result_parts.append(f"\\n**Signature**: \`{_target.__name__}{_sig}\`")
    except:
        pass
print("\\n".join(_result_parts))
del _target, _result_parts
`;
    try {
      const result = await executeCode(session.kernelId, inspectCode, 5000);
      if (result.status === "ok" && result.text) {
        return {
          content: [{ type: "text", text: result.text }],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Could not get info for "${word}": ${result.text || "unknown error"}`,
            },
          ],
        };
      }
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Could not get info for "${word}": ${e.message}`,
          },
        ],
      };
    }
  },

  "rename_symbol": async (args) => {
    const { path, cell_index, line, character, new_name } = args as {
      path: string;
      cell_index: number;
      line: number;
      character: number;
      new_name: string;
    };

    if (!isJupyterConnected()) {
      // Filesystem mode
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const cells = notebook.cells as { cell_type: string; source: string }[];

      const result = await renameSymbol(cells, cell_index, line, character, new_name);

      if (result.edits.length === 0) {
        return {
          content: [{ type: "text", text: "No changes — symbol may not have other references." }],
        };
      }

      // Apply edits to the notebook
      for (const edit of result.edits) {
        notebook.cells[edit.cellIndex].source = edit.newSource;
      }
      await writeNotebook(resolved, notebook);

      const details = result.edits
        .map((e) => `  Cell ${e.cellIndex}: ${e.oldSource.split("\n")[0]}... → ${e.newSource.split("\n")[0]}...`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text: `Renamed "${result.oldName}" → "${result.newName}" in ${result.edits.length} cell(s)\n\n${details}`,
        }],
      };
    }

    // Jupyter mode — read cells from Yjs, do rename, apply edits back
    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);
    const { doc } = await connectToNotebook(path, session?.kernelId);
    const yCells = doc.getArray("cells");

    // Build cell array for renameSymbol
    const cells: { cell_type: string; source: string }[] = [];
    for (let i = 0; i < yCells.length; i++) {
      const cell = yCells.get(i) as Y.Map<any>;
      cells.push({
        cell_type: getCellType(cell),
        source: extractSource(cell),
      });
    }

    const result = await renameSymbol(cells, cell_index, line, character, new_name);

    if (result.edits.length === 0) {
      return {
        content: [{ type: "text", text: "No changes — symbol may not have other references." }],
      };
    }

    // Apply edits back via Yjs
    for (const edit of result.edits) {
      const cell = yCells.get(edit.cellIndex) as Y.Map<any>;
      if (cell instanceof Y.Map) {
        const sourceField = cell.get("source");
        if (sourceField instanceof Y.Text) {
          sourceField.delete(0, sourceField.length);
          sourceField.insert(0, edit.newSource);
        } else {
          cell.set("source", new Y.Text(edit.newSource));
        }
      }
    }

    const details = result.edits
      .map((e) => `  Cell ${e.cellIndex}: ${e.oldSource.split("\n")[0]}... → ${e.newSource.split("\n")[0]}...`)
      .join("\n");

    return {
      content: [{
        type: "text",
        text: `Renamed "${result.oldName}" → "${result.newName}" in ${result.edits.length} cell(s)\n\n${details}`,
      }],
    };
  },
};
