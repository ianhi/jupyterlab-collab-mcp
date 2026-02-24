/**
 * Tests for the update_and_execute_range tool.
 * Tests schema registration, handler export, and validation error paths.
 * Full integration testing requires a running JupyterLab server.
 */

import { describe, it, expect } from "vitest";
import { toolSchemas } from "./schemas.js";
import { handlers as executeHandlers } from "./handlers/execute.js";

describe("update_and_execute_range", () => {
  describe("schema", () => {
    const schema = toolSchemas.find(
      (s) => s.name === "update_and_execute_range"
    );

    it("is registered in toolSchemas", () => {
      expect(schema).toBeDefined();
    });

    it("has the correct required fields", () => {
      expect(schema!.inputSchema.required).toEqual(["path", "updates"]);
    });

    it("has all expected properties", () => {
      const props = Object.keys(schema!.inputSchema.properties);
      expect(props).toContain("path");
      expect(props).toContain("updates");
      expect(props).toContain("execute_start_index");
      expect(props).toContain("execute_end_index");
      expect(props).toContain("execute_cell_ids");
      expect(props).toContain("force");
      expect(props).toContain("timeout");
      expect(props).toContain("max_images");
      expect(props).toContain("include_images");
      expect(props).toContain("client_name");
    });

    it("updates items support both index and cell_id", () => {
      const updatesSchema = schema!.inputSchema.properties.updates as any;
      const itemProps = updatesSchema.items.properties;
      expect(itemProps).toHaveProperty("index");
      expect(itemProps).toHaveProperty("cell_id");
      expect(itemProps).toHaveProperty("source");
    });

    it("updates items require source", () => {
      const updatesSchema = schema!.inputSchema.properties.updates as any;
      expect(updatesSchema.items.required).toEqual(["source"]);
    });

    it("has a description mentioning batch update and execute", () => {
      expect(schema!.description).toContain("Update");
      expect(schema!.description).toContain("execute");
      expect(schema!.description).toContain("range");
    });
  });

  describe("handler", () => {
    it("is exported from execute handlers", () => {
      expect(executeHandlers).toHaveProperty("update_and_execute_range");
      expect(typeof executeHandlers["update_and_execute_range"]).toBe(
        "function"
      );
    });

    it("throws when updates array is empty", async () => {
      await expect(
        executeHandlers["update_and_execute_range"]({
          path: "test.ipynb",
          updates: [],
        })
      ).rejects.toThrow("At least one update is required");
    });

    it("throws when not connected to JupyterLab", async () => {
      // Without connecting to JupyterLab, listNotebookSessions throws
      await expect(
        executeHandlers["update_and_execute_range"]({
          path: "nonexistent.ipynb",
          updates: [{ index: 0, source: "x = 1" }],
        })
      ).rejects.toThrow(/Not connected to JupyterLab|No kernel found/);
    });
  });

  describe("schema completeness", () => {
    it("every schema has a matching handler", () => {
      // Verify that all execute-related schemas have handlers
      const executeSchemas = toolSchemas.filter((s) =>
        [
          "execute_cell",
          "execute_code",
          "execute_range",
          "insert_and_execute",
          "update_and_execute",
          "update_and_execute_range",
          "clear_outputs",
          "get_cell_outputs",
        ].includes(s.name)
      );

      for (const schema of executeSchemas) {
        expect(
          executeHandlers,
          `Missing handler for ${schema.name}`
        ).toHaveProperty(schema.name);
      }
    });
  });
});
