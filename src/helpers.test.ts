import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellIndices,
  parseJupyterUrl,
  generateUnifiedDiff,
  formatOutputsAsText,
  extractOutputText,
  updateCellOutputs,
  createSafeRegex,
  extractMarkdownHeaders,
  getCodePreview,
  extractOutputsWithTraceback,
  truncateDiff,
  formatTimeRemaining,
  type ExecutionResult,
} from "./helpers.js";

describe("extractSource", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractSource(null)).toBe("");
    expect(extractSource(undefined)).toBe("");
  });

  it("extracts string source from plain object", () => {
    expect(extractSource({ source: "print('hello')" })).toBe("print('hello')");
  });

  it("extracts array source from plain object (joins lines)", () => {
    expect(extractSource({ source: ["line1\n", "line2"] })).toBe("line1\nline2");
  });

  it("extracts source from Y.Map with string", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("source", "x = 1");
    expect(extractSource(cell)).toBe("x = 1");
  });

  it("extracts source from Y.Map with Y.Text", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const text = new Y.Text("y = 2");
    cell.set("source", text);
    expect(extractSource(cell)).toBe("y = 2");
  });

  it("extracts source from Y.Map with array", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("source", ["a\n", "b"]);
    expect(extractSource(cell)).toBe("a\nb");
  });

  it("converts non-string truthy values to string", () => {
    expect(extractSource({ source: 123 })).toBe("123");
  });

  it("returns empty string for falsy source values", () => {
    expect(extractSource({ source: 0 })).toBe("");
    expect(extractSource({ source: false })).toBe("");
    expect(extractSource({ source: null })).toBe("");
  });

  it("returns empty string for empty source", () => {
    expect(extractSource({ source: "" })).toBe("");
    expect(extractSource({ source: [] })).toBe("");
  });

  it("handles object with missing source property", () => {
    expect(extractSource({})).toBe("");
    expect(extractSource({ other: "value" })).toBe("");
  });
});

describe("getCellType", () => {
  it("defaults to 'code' for null/undefined", () => {
    expect(getCellType(null)).toBe("code");
    expect(getCellType(undefined)).toBe("code");
  });

  it("returns cell_type from plain object", () => {
    expect(getCellType({ cell_type: "markdown" })).toBe("markdown");
    expect(getCellType({ cell_type: "code" })).toBe("code");
  });

  it("defaults to 'code' if cell_type missing", () => {
    expect(getCellType({})).toBe("code");
  });

  it("returns cell_type from Y.Map", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("cell_type", "markdown");
    expect(getCellType(cell)).toBe("markdown");
  });

  it("defaults to 'code' if Y.Map has no cell_type", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("source", "some code");
    expect(getCellType(cell)).toBe("code");
  });

  it("handles raw cell type", () => {
    expect(getCellType({ cell_type: "raw" })).toBe("raw");
  });
});

describe("getCellId", () => {
  it("returns undefined for null/undefined", () => {
    expect(getCellId(null)).toBeUndefined();
    expect(getCellId(undefined)).toBeUndefined();
  });

  it("returns id from plain object", () => {
    expect(getCellId({ id: "abc-123" })).toBe("abc-123");
  });

  it("returns id from Y.Map", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("id", "xyz-789");
    expect(getCellId(cell)).toBe("xyz-789");
  });

  it("returns undefined for object without id", () => {
    expect(getCellId({ source: "code" })).toBeUndefined();
  });

  it("returns undefined for Y.Map without id", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    cell.set("source", "code");
    expect(getCellId(cell)).toBeUndefined();
  });
});

describe("resolveCellIndices", () => {
  describe("with indices array", () => {
    it("returns sorted unique indices", () => {
      const result = resolveCellIndices(10, { indices: [5, 2, 8, 2] });
      expect(result.indices).toEqual([2, 5, 8]);
      expect(result.description).toBe("cells 2, 5, 8");
    });

    it("returns single cell description for one index", () => {
      const result = resolveCellIndices(10, { indices: [3] });
      expect(result.indices).toEqual([3]);
      expect(result.description).toBe("cell 3");
    });

    it("throws for invalid index", () => {
      expect(() => resolveCellIndices(5, { indices: [10] }))
        .toThrow("Invalid cell index 10. Notebook has 5 cells.");
    });

    it("throws for negative index", () => {
      expect(() => resolveCellIndices(5, { indices: [-1] }))
        .toThrow("Invalid cell index -1. Notebook has 5 cells.");
    });
  });

  describe("with index/end_index range", () => {
    it("returns range of indices (inclusive)", () => {
      const result = resolveCellIndices(10, { index: 2, end_index: 5 });
      expect(result.indices).toEqual([2, 3, 4, 5]);
      expect(result.description).toBe("cells 2-5");
    });

    it("returns single index when no end_index", () => {
      const result = resolveCellIndices(10, { index: 3 });
      expect(result.indices).toEqual([3]);
      expect(result.description).toBe("cell 3");
    });

    it("defaults to index 0 when nothing specified", () => {
      const result = resolveCellIndices(10, {});
      expect(result.indices).toEqual([0]);
      expect(result.description).toBe("cell 0");
    });

    it("throws for invalid range (start > end)", () => {
      expect(() => resolveCellIndices(10, { index: 5, end_index: 2 }))
        .toThrow("Invalid range [5, 2]. Notebook has 10 cells.");
    });

    it("throws for out of bounds", () => {
      expect(() => resolveCellIndices(5, { index: 0, end_index: 10 }))
        .toThrow("Invalid range [0, 10]. Notebook has 5 cells.");
    });
  });

  describe("indices takes precedence over index/end_index", () => {
    it("uses indices when both provided", () => {
      const result = resolveCellIndices(10, {
        index: 0,
        end_index: 9,
        indices: [2, 4]
      });
      expect(result.indices).toEqual([2, 4]);
    });
  });
});

describe("parseJupyterUrl", () => {
  it("parses localhost URL with token", () => {
    const result = parseJupyterUrl("http://localhost:8888/lab?token=abc123");
    expect(result).toEqual({
      host: "localhost",
      port: 8888,
      token: "abc123",
    });
  });

  it("parses URL without explicit port (http defaults to 80)", () => {
    const result = parseJupyterUrl("http://example.com/lab?token=xyz");
    expect(result).toEqual({
      host: "example.com",
      port: 80,
      token: "xyz",
    });
  });

  it("parses https URL (defaults to 443)", () => {
    const result = parseJupyterUrl("https://jupyter.example.com/lab?token=secure");
    expect(result).toEqual({
      host: "jupyter.example.com",
      port: 443,
      token: "secure",
    });
  });

  it("throws if token is missing", () => {
    expect(() => parseJupyterUrl("http://localhost:8888/lab"))
      .toThrow("URL must include a token parameter");
  });

  it("handles complex tokens with special characters", () => {
    const result = parseJupyterUrl("http://localhost:8888/lab?token=abc-123_XYZ");
    expect(result.token).toBe("abc-123_XYZ");
  });

  it("parses URL with custom port on https", () => {
    const result = parseJupyterUrl("https://example.com:9999/lab?token=test");
    expect(result).toEqual({
      host: "example.com",
      port: 9999,
      token: "test",
    });
  });

  it("parses URL with additional query parameters", () => {
    const result = parseJupyterUrl("http://localhost:8888/lab?token=mytoken&other=param");
    expect(result.token).toBe("mytoken");
  });

  it("parses 127.0.0.1 address", () => {
    const result = parseJupyterUrl("http://127.0.0.1:8888/lab?token=local");
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(8888);
  });

  it("throws for invalid URL", () => {
    expect(() => parseJupyterUrl("not-a-url")).toThrow();
  });

  it("throws for empty token", () => {
    expect(() => parseJupyterUrl("http://localhost:8888/lab?token="))
      .toThrow("URL must include a token parameter");
  });
});

describe("generateUnifiedDiff", () => {
  it("returns '(no changes)' for identical strings", () => {
    const result = generateUnifiedDiff("hello\nworld", "hello\nworld", "test.py");
    expect(result).toBe("(no changes)");
  });

  it("shows single line change", () => {
    const result = generateUnifiedDiff("hello", "goodbye", "test.py");
    expect(result).toContain("--- test.py (before)");
    expect(result).toContain("+++ test.py (after)");
    expect(result).toContain("-hello");
    expect(result).toContain("+goodbye");
  });

  it("shows added lines", () => {
    const result = generateUnifiedDiff("line1", "line1\nline2", "test.py");
    expect(result).toContain("+line2");
  });

  it("shows removed lines", () => {
    const result = generateUnifiedDiff("line1\nline2", "line1", "test.py");
    expect(result).toContain("-line2");
  });

  it("shows context around changes", () => {
    const oldStr = "a\nb\nc\nd\ne";
    const newStr = "a\nb\nX\nd\ne";
    const result = generateUnifiedDiff(oldStr, newStr, "test.py");
    expect(result).toContain(" b");  // context before
    expect(result).toContain("-c");
    expect(result).toContain("+X");
    expect(result).toContain(" d");  // context after
  });

  it("handles multiple changes", () => {
    const oldStr = "a\nb\nc\nd\ne\nf";
    const newStr = "X\nb\nc\nd\nY\nf";
    const result = generateUnifiedDiff(oldStr, newStr, "test.py");
    expect(result).toContain("-a");
    expect(result).toContain("+X");
    expect(result).toContain("-e");
    expect(result).toContain("+Y");
  });

  it("handles empty old string", () => {
    const result = generateUnifiedDiff("", "new content", "test.py");
    expect(result).toContain("+new content");
  });

  it("handles empty new string", () => {
    const result = generateUnifiedDiff("old content", "", "test.py");
    expect(result).toContain("-old content");
  });

  it("handles unicode characters", () => {
    const result = generateUnifiedDiff("hello 世界", "hello 🌍", "test.py");
    expect(result).toContain("-hello 世界");
    expect(result).toContain("+hello 🌍");
  });

  it("handles trailing newlines", () => {
    const result = generateUnifiedDiff("line1\n", "line1\nline2\n", "test.py");
    expect(result).toContain("+line2");
  });

  it("handles only whitespace changes", () => {
    const result = generateUnifiedDiff("  indented", "    indented", "test.py");
    expect(result).toContain("-  indented");
    expect(result).toContain("+    indented");
  });

  it("uses correct filename in header", () => {
    const result = generateUnifiedDiff("a", "b", "path/to/notebook.ipynb");
    expect(result).toContain("--- path/to/notebook.ipynb (before)");
    expect(result).toContain("+++ path/to/notebook.ipynb (after)");
  });
});

describe("formatOutputsAsText", () => {
  it("returns empty string for empty outputs", () => {
    expect(formatOutputsAsText([])).toBe("");
    expect(formatOutputsAsText(null as any)).toBe("");
    expect(formatOutputsAsText(undefined as any)).toBe("");
  });

  it("formats stream output", () => {
    const outputs = [{ output_type: "stream", text: "Hello, World!\n" }];
    expect(formatOutputsAsText(outputs)).toBe("Hello, World!\n");
  });

  it("formats execute_result output", () => {
    const outputs = [{
      output_type: "execute_result",
      data: { "text/plain": "42" }
    }];
    expect(formatOutputsAsText(outputs)).toBe("42");
  });

  it("formats display_data output", () => {
    const outputs = [{
      output_type: "display_data",
      data: { "text/plain": "<Figure size 640x480>" }
    }];
    expect(formatOutputsAsText(outputs)).toBe("<Figure size 640x480>");
  });

  it("formats error output", () => {
    const outputs = [{
      output_type: "error",
      ename: "ValueError",
      evalue: "invalid literal"
    }];
    expect(formatOutputsAsText(outputs)).toBe("ValueError: invalid literal");
  });

  it("combines multiple outputs", () => {
    const outputs = [
      { output_type: "stream", text: "Loading..." },
      { output_type: "execute_result", data: { "text/plain": "Done" } }
    ];
    expect(formatOutputsAsText(outputs)).toBe("Loading...Done");
  });
});

describe("extractOutputText", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractOutputText(null)).toBe("");
    expect(extractOutputText(undefined)).toBe("");
  });

  it("extracts stream text", () => {
    expect(extractOutputText({ output_type: "stream", text: "hello" })).toBe("hello");
  });

  it("extracts execute_result text/plain", () => {
    expect(extractOutputText({
      output_type: "execute_result",
      data: { "text/plain": "result" }
    })).toBe("result");
  });

  it("extracts display_data text/plain", () => {
    expect(extractOutputText({
      output_type: "display_data",
      data: { "text/plain": "display" }
    })).toBe("display");
  });

  it("formats error as ename: evalue", () => {
    expect(extractOutputText({
      output_type: "error",
      ename: "TypeError",
      evalue: "cannot add str and int"
    })).toBe("TypeError: cannot add str and int");
  });

  it("returns empty for missing data", () => {
    expect(extractOutputText({ output_type: "execute_result", data: {} })).toBe("");
  });
});

describe("updateCellOutputs", () => {
  function createExecutionResult(
    overrides: Partial<ExecutionResult> = {}
  ): ExecutionResult {
    return {
      status: "ok",
      executionCount: 1,
      outputs: [],
      text: "",
      images: [],
      html: [],
      ...overrides,
    };
  }

  it("sets execution_count on the cell", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({ executionCount: 42 });

    updateCellOutputs(cell, result);

    expect(cell.get("execution_count")).toBe(42);
  });

  it("creates outputs Y.Array if not present", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      outputs: [{ output_type: "stream", name: "stdout", text: "hello" }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    expect(outputs).toBeInstanceOf(Y.Array);
    expect(outputs.length).toBe(1);
  });

  it("clears existing outputs before adding new ones", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const existingOutputs = new Y.Array();
    const oldOutput = new Y.Map();
    oldOutput.set("output_type", "stream");
    existingOutputs.push([oldOutput]);
    cell.set("outputs", existingOutputs);

    const result = createExecutionResult({
      outputs: [{ output_type: "execute_result", data: { "text/plain": "new" } }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    expect(outputs.length).toBe(1);
    const output = outputs.get(0);
    expect(output.get("output_type")).toBe("execute_result");
  });

  it("handles stream output", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      outputs: [{ output_type: "stream", name: "stdout", text: "Hello, World!" }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    const output = outputs.get(0);
    expect(output.get("output_type")).toBe("stream");
    expect(output.get("name")).toBe("stdout");
    expect(output.get("text")).toBe("Hello, World!");
  });

  it("handles execute_result with nested data object", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      outputs: [{
        output_type: "execute_result",
        execution_count: 5,
        data: { "text/plain": "42", "text/html": "<b>42</b>" },
      }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    const output = outputs.get(0);
    expect(output.get("output_type")).toBe("execute_result");
    expect(output.get("execution_count")).toBe(5);
    const data = output.get("data");
    expect(data).toBeInstanceOf(Y.Map);
    expect(data.get("text/plain")).toBe("42");
    expect(data.get("text/html")).toBe("<b>42</b>");
  });

  it("handles error output", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      status: "error",
      outputs: [{
        output_type: "error",
        ename: "ValueError",
        evalue: "invalid literal",
        traceback: ["Traceback...", "  File...", "ValueError: invalid literal"],
      }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    const output = outputs.get(0);
    expect(output.get("output_type")).toBe("error");
    expect(output.get("ename")).toBe("ValueError");
    expect(output.get("evalue")).toBe("invalid literal");
    // traceback is an array, stored as Y.Array
    const traceback = output.get("traceback");
    expect(traceback).toBeInstanceOf(Y.Array);
  });

  it("handles display_data output", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      outputs: [{
        output_type: "display_data",
        data: { "text/plain": "<Figure size 640x480>" },
        metadata: {},
      }],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    const output = outputs.get(0);
    expect(output.get("output_type")).toBe("display_data");
    const data = output.get("data");
    expect(data.get("text/plain")).toBe("<Figure size 640x480>");
  });

  it("handles multiple outputs", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({
      outputs: [
        { output_type: "stream", name: "stdout", text: "Loading..." },
        { output_type: "stream", name: "stdout", text: "Done\n" },
        { output_type: "execute_result", data: { "text/plain": "Result" } },
      ],
    });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    expect(outputs.length).toBe(3);
    expect(outputs.get(0).get("text")).toBe("Loading...");
    expect(outputs.get(1).get("text")).toBe("Done\n");
    expect(outputs.get(2).get("data").get("text/plain")).toBe("Result");
  });

  it("handles null execution count", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({ executionCount: null });

    updateCellOutputs(cell, result);

    expect(cell.get("execution_count")).toBeNull();
  });

  it("handles empty outputs array", () => {
    const doc = new Y.Doc();
    const cell = doc.getMap("cell");
    const result = createExecutionResult({ outputs: [] });

    updateCellOutputs(cell, result);

    const outputs = cell.get("outputs") as Y.Array<any>;
    expect(outputs.length).toBe(0);
  });
});

describe("createSafeRegex", () => {
  it("creates regex from valid pattern", () => {
    const regex = createSafeRegex("hello");
    expect("hello world".match(regex)).toBeTruthy();
  });

  it("is case-insensitive by default", () => {
    const regex = createSafeRegex("hello");
    expect("HELLO".match(regex)).toBeTruthy();
  });

  it("respects caseSensitive parameter", () => {
    const regex = createSafeRegex("hello", true);
    expect("HELLO".match(regex)).toBeFalsy();
    expect("hello".match(regex)).toBeTruthy();
  });

  it("escapes invalid regex patterns", () => {
    // [unclosed bracket is invalid regex
    const regex = createSafeRegex("[unclosed");
    expect("[unclosed bracket".match(regex)).toBeTruthy();
  });

  it("escapes special characters in invalid patterns", () => {
    // Pattern with unmatched parenthesis is invalid regex
    const regex = createSafeRegex("func(arg");
    expect("call func(arg here".match(regex)).toBeTruthy();
  });

  it("handles complex regex patterns", () => {
    const regex = createSafeRegex("\\d+");
    expect("123".match(regex)).toBeTruthy();
    expect("abc".match(regex)).toBeFalsy();
  });

  it("handles empty pattern", () => {
    const regex = createSafeRegex("");
    expect("anything".match(regex)).toBeTruthy();
  });
});

describe("extractMarkdownHeaders", () => {
  it("extracts single header", () => {
    const headers = extractMarkdownHeaders("# Title");
    expect(headers).toEqual([{ level: 1, text: "Title" }]);
  });

  it("extracts multiple headers at different levels", () => {
    const source = "# Title\n## Section 1\n### Subsection\n## Section 2";
    const headers = extractMarkdownHeaders(source);
    expect(headers).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Section 1" },
      { level: 3, text: "Subsection" },
      { level: 2, text: "Section 2" },
    ]);
  });

  it("trims header text", () => {
    const headers = extractMarkdownHeaders("#   Spaced Title   ");
    expect(headers).toEqual([{ level: 1, text: "Spaced Title" }]);
  });

  it("ignores non-header lines", () => {
    const source = "Regular text\n# Header\nMore text";
    const headers = extractMarkdownHeaders(source);
    expect(headers).toEqual([{ level: 1, text: "Header" }]);
  });

  it("returns empty array for no headers", () => {
    const headers = extractMarkdownHeaders("No headers here\nJust text");
    expect(headers).toEqual([]);
  });

  it("handles h6 headers", () => {
    const headers = extractMarkdownHeaders("###### Deep header");
    expect(headers).toEqual([{ level: 6, text: "Deep header" }]);
  });

  it("ignores lines with more than 6 hashes", () => {
    const headers = extractMarkdownHeaders("####### Not a header");
    expect(headers).toEqual([]);
  });

  it("requires space after hashes", () => {
    const headers = extractMarkdownHeaders("#NoSpace");
    expect(headers).toEqual([]);
  });
});

describe("getCodePreview", () => {
  it("returns first line for short code", () => {
    expect(getCodePreview("print('hello')")).toBe("print('hello')");
  });

  it("truncates long lines", () => {
    const longLine = "x = " + "a".repeat(100);
    const preview = getCodePreview(longLine);
    expect(preview.length).toBe(63); // 60 + "..."
    expect(preview.endsWith("...")).toBe(true);
  });

  it("skips empty lines to find first code", () => {
    const code = "\n\n  \nprint('hello')";
    expect(getCodePreview(code)).toBe("print('hello')");
  });

  it("returns (empty) for empty or whitespace-only source", () => {
    expect(getCodePreview("")).toBe("(empty)");
    expect(getCodePreview("   \n  \n")).toBe("(empty)");
  });

  it("respects custom maxLength", () => {
    const preview = getCodePreview("print('hello world')", 10);
    expect(preview).toBe("print('hel...");
  });

  it("does not truncate if exactly at maxLength", () => {
    const preview = getCodePreview("1234567890", 10);
    expect(preview).toBe("1234567890");
  });
});

describe("extractOutputsWithTraceback", () => {
  it("returns empty string for empty outputs", () => {
    expect(extractOutputsWithTraceback([])).toBe("");
    expect(extractOutputsWithTraceback(null as any)).toBe("");
    expect(extractOutputsWithTraceback(undefined as any)).toBe("");
  });

  it("extracts stream output", () => {
    const outputs = [{ output_type: "stream", text: "Hello" }];
    expect(extractOutputsWithTraceback(outputs)).toBe("Hello");
  });

  it("extracts execute_result text/plain", () => {
    const outputs = [{
      output_type: "execute_result",
      data: { "text/plain": "42" },
    }];
    expect(extractOutputsWithTraceback(outputs)).toBe("42");
  });

  it("extracts error with traceback", () => {
    const outputs = [{
      output_type: "error",
      ename: "ValueError",
      evalue: "bad value",
      traceback: ["Traceback...", "  File 'test.py'", "ValueError: bad value"],
    }];
    const result = extractOutputsWithTraceback(outputs);
    expect(result).toContain("ValueError: bad value");
    expect(result).toContain("Traceback...");
    expect(result).toContain("File 'test.py'");
  });

  it("combines multiple outputs with newlines", () => {
    const outputs = [
      { output_type: "stream", text: "Loading" },
      { output_type: "execute_result", data: { "text/plain": "Done" } },
    ];
    expect(extractOutputsWithTraceback(outputs)).toBe("Loading\nDone");
  });

  it("handles error without traceback", () => {
    const outputs = [{
      output_type: "error",
      ename: "Error",
      evalue: "message",
    }];
    expect(extractOutputsWithTraceback(outputs)).toBe("Error: message");
  });
});

describe("truncateDiff", () => {
  it("returns unchanged diff if within maxLines", () => {
    const diff = "line1\nline2\nline3";
    expect(truncateDiff(diff, 10)).toBe(diff);
  });

  it("truncates diff that exceeds maxLines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
    const diff = lines.join("\n");
    const result = truncateDiff(diff, 10);

    // Should have first 5 lines, omission message, last 5 lines
    expect(result).toContain("line1");
    expect(result).toContain("line5");
    expect(result).toContain("... 40 lines omitted ...");
    expect(result).toContain("line46");
    expect(result).toContain("line50");
    expect(result).not.toContain("line25");
  });

  it("uses default maxLines of 30", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const diff = lines.join("\n");
    const result = truncateDiff(diff);

    expect(result).toContain("... 10 lines omitted ...");
  });

  it("handles exact maxLines boundary", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const diff = lines.join("\n");
    const result = truncateDiff(diff, 30);

    // Should not truncate
    expect(result).toBe(diff);
  });

  it("handles one line over maxLines", () => {
    const lines = Array.from({ length: 31 }, (_, i) => `line${i + 1}`);
    const diff = lines.join("\n");
    const result = truncateDiff(diff, 30);

    expect(result).toContain("... 1 lines omitted ...");
  });
});

describe("formatTimeRemaining", () => {
  it("formats zero seconds", () => {
    expect(formatTimeRemaining(0)).toBe("0s");
  });

  it("formats negative values as 0s", () => {
    expect(formatTimeRemaining(-5)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatTimeRemaining(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatTimeRemaining(330)).toBe("5m 30s");
  });

  it("formats exact minutes", () => {
    expect(formatTimeRemaining(120)).toBe("2m 0s");
  });

  it("formats large values", () => {
    expect(formatTimeRemaining(3661)).toBe("61m 1s");
  });

  it("rounds fractional seconds", () => {
    expect(formatTimeRemaining(59.7)).toBe("1m 0s");
  });
});
