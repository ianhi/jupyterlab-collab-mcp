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
    },
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
  console.error("JupyterLab MCP server started. Use connect_jupyter tool with your JupyterLab URL to begin.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
