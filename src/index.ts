#!/usr/bin/env node
/**
 * MCP Server for JupyterLab notebook collaboration.
 *
 * Connects to JupyterLab's real-time collaboration system via y-websocket,
 * allowing Claude Code to read, edit, and execute notebooks.
 *
 * Usage: The user provides a JupyterLab URL (with token) via the connect_jupyter tool.
 * No environment variables needed!
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolSchemas } from "./schemas.js";

import { handlers as connectionHandlers } from "./handlers/connection.js";
import { handlers as cellReadHandlers } from "./handlers/cell-read.js";
import { handlers as cellWriteHandlers } from "./handlers/cell-write.js";
import { handlers as executeHandlers } from "./handlers/execute.js";
import { handlers as metadataHandlers } from "./handlers/metadata.js";
import { handlers as kernelLspHandlers } from "./handlers/kernel-lsp.js";
import { handlers as collabHandlers } from "./handlers/collab.js";
import { setNotifier, type HandoffCompletePayload } from "./notifications.js";

// ============================================================================
// Merge all handler maps
// ============================================================================

const allHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {
  ...connectionHandlers,
  ...cellReadHandlers,
  ...cellWriteHandlers,
  ...executeHandlers,
  ...metadataHandlers,
  ...kernelLspHandlers,
  ...collabHandlers,
};

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  {
    name: "jupyterlab-collab-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        // Push notification used to wake the agent when a previously
        // handed-off cell run terminates. The user opts in per-launch
        // with `claude --channels server:jupyter`; otherwise the host
        // drops the notification silently.
        "claude/channel": {},
      },
    },
    instructions:
      "When a <channel source=\"jupyter\"> tag arrives, a previously handed-off cell run has terminated. " +
      "Call get_cell_run_output(run_id=<meta.run_id>) to fetch the final output, then continue with whatever " +
      "the user originally asked you to do with that cell's result.",
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolSchemas };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const handler = allHandlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return await handler(args as Record<string, unknown>);
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Wire the handoff-complete notifier now that the server is connected.
  setNotifier((p: HandoffCompletePayload) => {
    const head = p.first_line ?? "(no output)";
    server
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: `Cell run ${p.run_id} finished (status=${p.status}). First line: ${head}`,
          meta: {
            run_id: p.run_id,
            kernel_id: p.kernel_id,
            status: p.status,
            execution_count:
              p.execution_count === null || p.execution_count === undefined
                ? ""
                : String(p.execution_count),
          },
        },
      })
      .catch(() => {
        // Notification is best-effort; host may not have opted in.
      });
  });

  console.error("JupyterLab MCP server started. Use connect_jupyter tool with your JupyterLab URL to begin.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
