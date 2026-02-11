import type { ToolResult } from "../handler-types.js";
import { parseJupyterUrl } from "../helpers.js";
import {
  resolveNotebookPath,
  createEmptyNotebook,
  writeNotebook,
} from "../notebook-fs.js";
import {
  setJupyterConfig,
  isJupyterConnected,
  checkLspAvailability,
  apiFetch,
  listNotebookSessions,
  connectedNotebooks,
} from "../connection.js";
import { readdir, stat, rename as fsRename } from "node:fs/promises";
import { join } from "node:path";

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  connect_jupyter: async (args) => {
    const { url } = args as { url: string };
    const parsed = parseJupyterUrl(url);

    const config = {
      host: parsed.host,
      port: parsed.port,
      token: parsed.token,
      baseUrl: `http://${parsed.host}:${parsed.port}`,
      wsUrl: `ws://${parsed.host}:${parsed.port}`,
    };
    setJupyterConfig(config);

    // Test connection by listing sessions
    const response = await apiFetch("/api/sessions");
    if (!response.ok) {
      setJupyterConfig(null);
      throw new Error(`Failed to connect: ${response.statusText}`);
    }

    const sessions: any[] = await response.json();
    const notebooks = sessions.filter((s) => s.type === "notebook");

    // Check for LSP availability (optional enhancement)
    const lsp = await checkLspAvailability();
    const lspInfo = lsp.available
      ? `\n\nLSP available: ${[...lsp.servers.keys()].join(", ") || "checking..."}`
      : "\n\nLSP: not available (install jupyterlab-lsp for enhanced diagnostics)";

    return {
      content: [
        {
          type: "text",
          text: `Connected to JupyterLab at ${config.baseUrl}\n\nOpen notebooks:\n${
            notebooks.length > 0
              ? notebooks.map((n) => `- ${n.path}`).join("\n")
              : "(no notebooks open)"
          }${lspInfo}`,
        },
      ],
    };
  },

  list_notebooks: async (_args) => {
    const notebooks = await listNotebookSessions();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(notebooks, null, 2),
        },
      ],
    };
  },

  list_kernels: async (_args) => {
    // Get available kernel specs
    const specsResponse = await apiFetch("/api/kernelspecs");
    if (!specsResponse.ok) {
      throw new Error(`Failed to list kernel specs: ${specsResponse.statusText}`);
    }
    const specsData = await specsResponse.json();

    // Get running kernel instances
    const kernelsResponse = await apiFetch("/api/kernels");
    if (!kernelsResponse.ok) {
      throw new Error(`Failed to list kernels: ${kernelsResponse.statusText}`);
    }
    const kernels: any[] = await kernelsResponse.json();

    // Format kernel specs
    const specs = Object.entries(specsData.kernelspecs || {}).map(
      ([name, spec]: [string, any]) => ({
        name,
        displayName: spec.spec?.display_name || name,
        language: spec.spec?.language || "unknown",
      })
    );

    // Format running kernels
    const running = kernels.map((k: any) => ({
      id: k.id,
      name: k.name,
      state: k.execution_state,
      lastActivity: k.last_activity,
    }));

    const lines: string[] = [];
    lines.push(`Available kernel types (default: ${specsData.default || "python3"}):`);
    for (const s of specs) {
      lines.push(`  - ${s.name} (${s.displayName}, ${s.language})`);
    }
    lines.push("");
    lines.push(`Running kernels: ${running.length}`);
    for (const k of running) {
      lines.push(`  - ${k.id.slice(0, 8)} [${k.name}] ${k.state} (last activity: ${k.lastActivity})`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },

  list_files: async (args) => {
    const { path = "" } = args as { path?: string };

    if (!isJupyterConnected()) {
      const resolved = path ? resolveNotebookPath(path) : process.cwd();
      const dirStat = await stat(resolved);

      if (!dirStat.isDirectory()) {
        // Single file info
        const fileStat = await stat(resolved);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: resolved.split("/").pop(),
                  path: resolved,
                  type: resolved.endsWith(".ipynb") ? "notebook" : "file",
                  size: fileStat.size,
                  last_modified: fileStat.mtime.toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const entries = await readdir(resolved, { withFileTypes: true });
      const items = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.name.endsWith(".ipynb")
            ? "notebook"
            : "file",
        path: join(resolved, entry.name),
      }));

      items.sort((a, b) => {
        const typeOrder: Record<string, number> = {
          directory: 0,
          notebook: 1,
          file: 2,
        };
        const aOrder = typeOrder[a.type] ?? 3;
        const bOrder = typeOrder[b.type] ?? 3;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
      });

      return {
        content: [
          {
            type: "text",
            text: `Files in ${resolved}:\n\n${JSON.stringify(items, null, 2)}`,
          },
        ],
      };
    }

    const response = await apiFetch(
      `/api/contents/${encodeURIComponent(path)}`
    );
    if (!response.ok) {
      throw new Error(`Failed to list files: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.type !== "directory") {
      // Single file info
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: data.name,
                path: data.path,
                type: data.type,
                size: data.size,
                last_modified: data.last_modified,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Directory listing
    const items = data.content.map((item: any) => ({
      name: item.name,
      type: item.type,
      path: item.path,
      ...(item.type === "notebook" ? { kernel: item.kernel_name } : {}),
    }));

    // Sort: directories first, then notebooks, then other files
    items.sort((a: any, b: any) => {
      const typeOrder: Record<string, number> = {
        directory: 0,
        notebook: 1,
        file: 2,
      };
      const aOrder = typeOrder[a.type] ?? 3;
      const bOrder = typeOrder[b.type] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });

    return {
      content: [
        {
          type: "text",
          text: `Files in ${path || "/"}:\n\n${JSON.stringify(items, null, 2)}`,
        },
      ],
    };
  },

  open_notebook: async (args) => {
    const { path, kernel_name } = args as {
      path: string;
      kernel_name?: string;
    };

    // Check if notebook exists
    const checkResponse = await apiFetch(
      `/api/contents/${encodeURIComponent(path)}`
    );
    if (!checkResponse.ok) {
      throw new Error(`Notebook not found: ${path}`);
    }

    // Check if already open
    const existingSessions = await listNotebookSessions();
    const existing = existingSessions.find((s) => s.path === path);
    if (existing) {
      return {
        content: [
          {
            type: "text",
            text: `Notebook already open: ${path} (kernel: ${existing.kernelId || "none"})`,
          },
        ],
      };
    }

    // Create a new session (opens notebook with kernel)
    const sessionResponse = await apiFetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        path,
        type: "notebook",
        kernel: kernel_name ? { name: kernel_name } : undefined,
      }),
    });

    if (!sessionResponse.ok) {
      const error = await sessionResponse.text();
      throw new Error(`Failed to open notebook: ${error}`);
    }

    const session = await sessionResponse.json();

    return {
      content: [
        {
          type: "text",
          text: `Opened notebook: ${path}\nKernel: ${session.kernel?.name || "none"} (${session.kernel?.id || "no id"})`,
        },
      ],
    };
  },

  create_notebook: async (args) => {
    const {
      path,
      kernel_name = "python3",
      open = true,
    } = args as {
      path: string;
      kernel_name?: string;
      open?: boolean;
    };

    // Ensure path ends with .ipynb
    const nbPath = path.endsWith(".ipynb") ? path : `${path}.ipynb`;

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(nbPath);

      // Check if file already exists
      try {
        await stat(resolved);
        throw new Error(`File already exists: ${nbPath}`);
      } catch (e: any) {
        if (e.message?.startsWith("File already exists")) throw e;
        // ENOENT means file doesn't exist - that's what we want
      }

      const emptyNb = createEmptyNotebook(kernel_name);
      await writeNotebook(resolved, emptyNb);

      return {
        content: [{ type: "text", text: `Created notebook: ${nbPath}` }],
      };
    }

    // Check if file already exists
    const checkResponse = await apiFetch(
      `/api/contents/${encodeURIComponent(nbPath)}`
    );
    if (checkResponse.ok) {
      throw new Error(`File already exists: ${nbPath}`);
    }

    // Create empty notebook structure
    const emptyNotebook = {
      cells: [],
      metadata: {
        kernelspec: {
          display_name:
            kernel_name === "python3" ? "Python 3" : kernel_name,
          language: "python",
          name: kernel_name,
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };

    // Create the notebook file
    const createResponse = await apiFetch(
      `/api/contents/${encodeURIComponent(nbPath)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          type: "notebook",
          content: emptyNotebook,
        }),
      }
    );

    if (!createResponse.ok) {
      const error = await createResponse.text();
      throw new Error(`Failed to create notebook: ${error}`);
    }

    let result = `Created notebook: ${nbPath}`;

    // Optionally open it
    if (open) {
      const sessionResponse = await apiFetch("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          path: nbPath,
          type: "notebook",
          kernel: { name: kernel_name },
        }),
      });

      if (sessionResponse.ok) {
        const session = await sessionResponse.json();
        result += `\nOpened with kernel: ${session.kernel?.name || kernel_name}`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  },

  rename_notebook: async (args) => {
    const { path, new_path } = args as {
      path: string;
      new_path: string;
    };

    if (!new_path.endsWith(".ipynb")) {
      throw new Error("New path must end in .ipynb");
    }

    if (!isJupyterConnected()) {
      const resolvedOld = resolveNotebookPath(path);
      const resolvedNew = resolveNotebookPath(new_path);
      await fsRename(resolvedOld, resolvedNew);
      return {
        content: [
          { type: "text", text: `Renamed ${path} to ${new_path}` },
        ],
      };
    }

    // Disconnect from notebook if connected
    const existing = connectedNotebooks.get(path);
    if (existing) {
      existing.provider.destroy();
      connectedNotebooks.delete(path);
    }

    // Use Jupyter contents API to rename
    const response = await apiFetch(
      `/api/contents/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ path: new_path }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to rename notebook: ${response.status} ${error}`
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `Renamed ${path} to ${new_path}`,
        },
      ],
    };
  },
};
