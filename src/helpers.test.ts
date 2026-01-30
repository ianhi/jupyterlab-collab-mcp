import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellIndices,
  parseJupyterUrl,
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
});
