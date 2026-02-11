import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  sourceToLines,
  createEmptyNotebook,
} from "./notebook-fs.js";

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

describe("readNotebook", () => {
  it("reads and parses simple.ipynb", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    expect(nb.nbformat).toBe(4);
    expect(nb.cells.length).toBe(7);
    expect(nb.metadata.kernelspec.name).toBe("python3");
  });

  it("reads empty notebook", async () => {
    const nb = await readNotebook(join(FIXTURES, "empty.ipynb"));
    expect(nb.cells.length).toBe(0);
    expect(nb.nbformat).toBe(4);
  });

  it("normalizes array sources to strings", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    // All sources should be strings after normalization
    for (const cell of nb.cells) {
      expect(typeof cell.source).toBe("string");
    }
  });

  it("preserves cell types", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    expect(nb.cells[0].cell_type).toBe("markdown");
    expect(nb.cells[1].cell_type).toBe("code");
  });

  it("preserves outputs", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    // Cell 2 (index 2) has stream output
    expect(nb.cells[2].outputs).toHaveLength(1);
    expect(nb.cells[2].outputs![0].output_type).toBe("stream");
    expect(nb.cells[2].outputs![0].text).toBe("Hello, World!\n");
  });

  it("preserves cell metadata and tags", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    expect(nb.cells[2].metadata.tags).toEqual(["parameters"]);
    expect(nb.cells[4].metadata.tags).toEqual(["hide-input", "parameters"]);
  });

  it("throws for non-existent file", async () => {
    await expect(readNotebook("/nonexistent/path.ipynb")).rejects.toThrow();
  });
});

describe("writeNotebook", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-fs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("writes and re-reads a notebook", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const outPath = join(tmpDir, "output.ipynb");

    await writeNotebook(outPath, nb);
    const reRead = await readNotebook(outPath);

    expect(reRead.nbformat).toBe(nb.nbformat);
    expect(reRead.cells.length).toBe(nb.cells.length);
    expect(reRead.metadata.kernelspec.name).toBe("python3");
  });

  it("converts source strings to line arrays in file", async () => {
    const nb = createEmptyNotebook();
    nb.cells.push({
      cell_type: "code",
      source: "a = 1\nb = 2",
      metadata: {},
      outputs: [],
      execution_count: null,
    });

    const outPath = join(tmpDir, "lines.ipynb");
    await writeNotebook(outPath, nb);

    // Read raw JSON to verify line format
    const raw = JSON.parse(await readFile(outPath, "utf-8"));
    expect(raw.cells[0].source).toEqual(["a = 1\n", "b = 2"]);
  });

  it("writes trailing newline", async () => {
    const nb = createEmptyNotebook();
    const outPath = join(tmpDir, "trailing.ipynb");
    await writeNotebook(outPath, nb);

    const raw = await readFile(outPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("round-trips preserving cell content", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const outPath = join(tmpDir, "roundtrip.ipynb");

    await writeNotebook(outPath, nb);
    const reRead = await readNotebook(outPath);

    for (let i = 0; i < nb.cells.length; i++) {
      expect(reRead.cells[i].source).toBe(nb.cells[i].source);
      expect(reRead.cells[i].cell_type).toBe(nb.cells[i].cell_type);
    }
  });
});

describe("resolveNotebookPath", () => {
  it("returns absolute path unchanged", () => {
    expect(resolveNotebookPath("/tmp/test.ipynb")).toBe("/tmp/test.ipynb");
  });

  it("resolves relative path against cwd", () => {
    const result = resolveNotebookPath("test.ipynb");
    expect(result).toBe(join(process.cwd(), "test.ipynb"));
  });

  it("resolves nested relative path", () => {
    const result = resolveNotebookPath("sub/dir/test.ipynb");
    expect(result).toBe(join(process.cwd(), "sub", "dir", "test.ipynb"));
  });
});

describe("sourceToLines", () => {
  it("splits multi-line string with trailing newlines", () => {
    expect(sourceToLines("a\nb")).toEqual(["a\n", "b"]);
  });

  it("handles single line", () => {
    expect(sourceToLines("hello")).toEqual(["hello"]);
  });

  it("handles empty string", () => {
    expect(sourceToLines("")).toEqual([]);
  });

  it("handles multiple lines", () => {
    expect(sourceToLines("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
  });

  it("preserves trailing newline in source", () => {
    expect(sourceToLines("a\n")).toEqual(["a\n", ""]);
  });

  it("handles single newline", () => {
    expect(sourceToLines("\n")).toEqual(["\n", ""]);
  });
});

describe("createEmptyNotebook", () => {
  it("creates valid notebook structure", () => {
    const nb = createEmptyNotebook();
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.cells).toEqual([]);
    expect(nb.metadata.kernelspec.name).toBe("python3");
    expect(nb.metadata.kernelspec.display_name).toBe("Python 3");
  });

  it("accepts custom kernel name", () => {
    const nb = createEmptyNotebook("julia-1.9");
    expect(nb.metadata.kernelspec.name).toBe("julia-1.9");
    expect(nb.metadata.kernelspec.display_name).toBe("julia-1.9");
  });
});
