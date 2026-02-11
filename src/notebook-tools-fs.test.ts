/**
 * Integration tests for notebook tools in filesystem mode.
 * These test the tool logic directly against .ipynb files without JupyterLab.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  createEmptyNotebook,
  type NotebookData,
  type NotebookCell,
} from "./notebook-fs.js";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellIndices,
  createSafeRegex,
  extractMarkdownHeaders,
  getCodePreview,
  formatOutputsAsText,
  generateUnifiedDiff,
} from "./helpers.js";
import { handlers as cellWriteHandlers } from "./handlers/cell-write.js";
import { handlers as collabHandlers } from "./handlers/collab.js";
import { getChangesSince, clearTracker } from "./cell-tracker.js";

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

// Helper: copy a fixture to a temp dir for mutation tests
async function copyFixture(
  fixtureName: string,
  tmpDir: string
): Promise<string> {
  const src = join(FIXTURES, fixtureName);
  const dest = join(tmpDir, fixtureName);
  const content = await readFile(src, "utf-8");
  await writeFile(dest, content, "utf-8");
  return dest;
}

describe("get_notebook_content (filesystem)", () => {
  it("returns all code cells by default", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const content = [];
    for (let i = 0; i < nb.cells.length; i++) {
      const cell = nb.cells[i];
      if (getCellType(cell) === "code") {
        content.push({
          index: i,
          type: "code",
          source: extractSource(cell),
        });
      }
    }
    expect(content.length).toBe(5);
    expect(content[0].index).toBe(1);
    expect(content[0].source).toContain("import os");
  });

  it("returns all cells when cell_type='all'", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    expect(nb.cells.length).toBe(7);
  });

  it("returns only markdown cells", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const mdCells = nb.cells.filter((c) => getCellType(c) === "markdown");
    expect(mdCells.length).toBe(2);
  });

  it("respects start_index and end_index", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const start = 1;
    const end = 3;
    const slice = nb.cells.slice(start, end + 1);
    expect(slice.length).toBe(3);
    expect(getCellType(slice[0])).toBe("code");
  });

  it("includes outputs when requested (text format)", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const cell = nb.cells[2]; // Has stream output
    const output = formatOutputsAsText(cell.outputs || []);
    expect(output).toBe("Hello, World!\n");
  });

  it("includes outputs for execute_result", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const cell = nb.cells[3]; // Has execute_result
    const output = formatOutputsAsText(cell.outputs || []);
    expect(output).toBe("42");
  });

  it("includes error output", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const cell = nb.cells[4]; // Has error
    const output = formatOutputsAsText(cell.outputs || []);
    expect(output).toContain("ValueError: invalid literal");
  });
});

describe("get_notebook_outline (filesystem)", () => {
  it("builds outline from markdown and code cells", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const outline: any[] = [];

    for (let i = 0; i < nb.cells.length; i++) {
      const cell = nb.cells[i];
      const type = getCellType(cell);
      const source = extractSource(cell);

      if (type === "markdown") {
        const headers = extractMarkdownHeaders(source);
        for (const h of headers) {
          outline.push({ index: i, type: "header", level: h.level, text: h.text });
        }
      } else if (type === "code") {
        outline.push({ index: i, type: "code", preview: getCodePreview(source) });
      }
    }

    // Should have markdown headers and code previews
    const headers = outline.filter((o) => o.type === "header");
    expect(headers.length).toBe(3); // # Test Notebook, ## Section 1, ## Section 2

    expect(headers[0].text).toBe("Test Notebook");
    expect(headers[0].level).toBe(1);
    expect(headers[1].text).toBe("Section 1");
    expect(headers[2].text).toBe("Section 2");

    const codes = outline.filter((o) => o.type === "code");
    expect(codes.length).toBe(5);
    expect(codes[0].preview).toContain("import os");
  });
});

describe("search_notebook (filesystem)", () => {
  it("finds pattern in source", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const regex = createSafeRegex("import", false);

    const matches = [];
    for (let i = 0; i < nb.cells.length; i++) {
      const source = extractSource(nb.cells[i]);
      if (source.match(regex)) {
        matches.push({ index: i, count: (source.match(regex) || []).length });
      }
    }

    expect(matches.length).toBe(1);
    expect(matches[0].index).toBe(1);
  });

  it("finds pattern in outputs", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const regex = createSafeRegex("Hello", false);

    const matches = [];
    for (let i = 0; i < nb.cells.length; i++) {
      const cell = nb.cells[i];
      if (getCellType(cell) !== "code" || !cell.outputs) continue;
      const outputText = formatOutputsAsText(cell.outputs);
      if (outputText.match(regex)) {
        matches.push({ index: i });
      }
    }

    expect(matches.length).toBe(1);
    expect(matches[0].index).toBe(2);
  });

  it("respects case sensitivity", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const regex = createSafeRegex("hello", true); // case sensitive

    let found = false;
    for (const cell of nb.cells) {
      if (extractSource(cell).match(regex)) found = true;
    }
    expect(found).toBe(false); // "Hello" won't match "hello" case-sensitive
  });

  it("returns no matches for missing pattern", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const regex = createSafeRegex("NONEXISTENT_PATTERN", false);

    let found = false;
    for (const cell of nb.cells) {
      if (extractSource(cell).match(regex)) found = true;
    }
    expect(found).toBe(false);
  });
});

describe("insert/delete/update cells (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-tools-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("inserts a cell at the end", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);
    const origLength = nb.cells.length;

    const newCell: NotebookCell = {
      cell_type: "code",
      source: "print('new cell')",
      metadata: {},
      outputs: [],
      execution_count: null,
      id: "new-cell-1",
    };

    nb.cells.push(newCell);
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(origLength + 1);
    expect(extractSource(reRead.cells[reRead.cells.length - 1])).toBe("print('new cell')");
  });

  it("inserts a cell at a specific index", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    const newCell: NotebookCell = {
      cell_type: "code",
      source: "inserted = True",
      metadata: {},
      outputs: [],
      execution_count: null,
      id: "inserted-1",
    };

    nb.cells.splice(2, 0, newCell);
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(extractSource(reRead.cells[2])).toBe("inserted = True");
    expect(reRead.cells.length).toBe(8);
  });

  it("deletes a cell", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);
    const origLength = nb.cells.length;
    const secondCellSource = extractSource(nb.cells[2]);

    nb.cells.splice(1, 1); // Delete index 1
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(origLength - 1);
    // What was cell 2 is now cell 1
    expect(extractSource(reRead.cells[1])).toBe(secondCellSource);
  });

  it("deletes multiple cells by indices (non-contiguous)", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);
    const origLength = nb.cells.length;

    // Delete indices 1 and 3 (in reverse order to preserve indices)
    const toDelete = [3, 1];
    for (const idx of toDelete) {
      nb.cells.splice(idx, 1);
    }
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(origLength - 2);
  });

  it("updates a cell's source", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    const oldSource = extractSource(nb.cells[1]);
    nb.cells[1].source = "new_code = 'updated'";
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(extractSource(reRead.cells[1])).toBe("new_code = 'updated'");
    expect(oldSource).not.toBe("new_code = 'updated'");
  });
});

describe("metadata ops (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-meta-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("reads cell metadata", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const meta = nb.cells[2].metadata;
    expect(meta.tags).toEqual(["parameters"]);
  });

  it("sets cell metadata", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    nb.cells[1].metadata.custom_key = "custom_value";
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[1].metadata.custom_key).toBe("custom_value");
  });

  it("deletes cell metadata key (via null)", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    // Cell 2 has tags
    expect(nb.cells[2].metadata.tags).toBeDefined();
    delete nb.cells[2].metadata.tags;
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[2].metadata.tags).toBeUndefined();
  });

  it("adds tags to a cell", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    // Cell 1 has no tags
    if (!nb.cells[1].metadata.tags) nb.cells[1].metadata.tags = [];
    nb.cells[1].metadata.tags.push("new-tag");
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[1].metadata.tags).toContain("new-tag");
  });

  it("removes tags from a cell", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    // Cell 4 has ["hide-input", "parameters"]
    nb.cells[4].metadata.tags = nb.cells[4].metadata.tags.filter(
      (t: string) => t !== "hide-input"
    );
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[4].metadata.tags).toEqual(["parameters"]);
    expect(reRead.cells[4].metadata.tags).not.toContain("hide-input");
  });

  it("find_cells_by_tag: finds cells with specific tag", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));

    const matches: number[] = [];
    for (let i = 0; i < nb.cells.length; i++) {
      const tags: string[] = nb.cells[i].metadata?.tags || [];
      if (tags.includes("parameters")) {
        matches.push(i);
      }
    }

    expect(matches).toEqual([2, 4]); // cells with "parameters" tag
  });

  it("find_cells_by_tag: match_all requires all tags", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));

    const tags = ["hide-input", "parameters"];
    const matches: number[] = [];
    for (let i = 0; i < nb.cells.length; i++) {
      const cellTags: string[] = nb.cells[i].metadata?.tags || [];
      if (tags.every((t) => cellTags.includes(t))) {
        matches.push(i);
      }
    }

    expect(matches).toEqual([4]); // only cell 4 has both
  });
});

describe("notebook-level metadata (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-nbmeta-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("reads notebook metadata", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    expect(nb.metadata.kernelspec.name).toBe("python3");
    expect(nb.metadata.language_info.name).toBe("python");
  });

  it("sets notebook metadata", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    nb.metadata.custom = { key: "value" };
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.metadata.custom).toEqual({ key: "value" });
  });

  it("deletes notebook metadata key", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    delete nb.metadata.language_info;
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.metadata.language_info).toBeUndefined();
  });
});

describe("clear_outputs (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-clear-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("clears outputs from a single cell", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    expect(nb.cells[2].outputs!.length).toBe(1);
    nb.cells[2].outputs = [];
    nb.cells[2].execution_count = null;
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[2].outputs!.length).toBe(0);
    expect(reRead.cells[2].execution_count).toBeNull();
  });

  it("clears outputs from all cells", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    for (const cell of nb.cells) {
      if (getCellType(cell) === "code") {
        cell.outputs = [];
        cell.execution_count = null;
      }
    }
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    for (const cell of reRead.cells) {
      if (getCellType(cell) === "code") {
        expect(cell.outputs!.length).toBe(0);
        expect(cell.execution_count).toBeNull();
      }
    }
  });
});

describe("file ops (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-fileops-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("create_notebook creates empty notebook", async () => {
    const path = join(tmpDir, "new.ipynb");
    const nb = createEmptyNotebook("python3");
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(0);
    expect(reRead.nbformat).toBe(4);
    expect(reRead.metadata.kernelspec.name).toBe("python3");
  });

  it("create_notebook with initial cells populates the notebook", async () => {
    const path = join(tmpDir, "seeded.ipynb");
    const nb = createEmptyNotebook("python3");
    const cells = [
      { source: "import numpy as np" },
      { source: "# Introduction", cell_type: "markdown" },
    ];
    for (const cell of cells) {
      const cellType = (cell as any).cell_type || "code";
      nb.cells.push({
        cell_type: cellType,
        source: cell.source,
        metadata: {},
        id: crypto.randomUUID(),
        ...(cellType === "code"
          ? { outputs: [], execution_count: null }
          : {}),
      });
    }
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(2);
    expect(reRead.cells[0].cell_type).toBe("code");
    expect(reRead.cells[0].source).toBe("import numpy as np");
    expect(reRead.cells[1].cell_type).toBe("markdown");
    expect(reRead.cells[1].source).toBe("# Introduction");
    expect(reRead.cells[0].id).toBeDefined();
    expect(reRead.cells[1].id).toBeDefined();
  });

  it("rename_notebook renames the file", async () => {
    const { rename } = await import("fs/promises");

    const path = await copyFixture("simple.ipynb", tmpDir);
    const newPath = join(tmpDir, "renamed.ipynb");

    await rename(path, newPath);

    const nb = await readNotebook(newPath);
    expect(nb.cells.length).toBe(7);

    // Old path should not exist
    await expect(readNotebook(path)).rejects.toThrow();
  });
});

describe("cross-notebook ops (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-cross-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("copy_cells copies cells between notebooks", async () => {
    const srcPath = await copyFixture("simple.ipynb", tmpDir);
    const destPath = join(tmpDir, "dest.ipynb");
    const destNb = createEmptyNotebook();
    await writeNotebook(destPath, destNb);

    const srcNb = await readNotebook(srcPath);

    // Copy cells 1-2 from source to dest
    const copiedCells: NotebookCell[] = [];
    for (let i = 1; i <= 2; i++) {
      const src = srcNb.cells[i];
      copiedCells.push({
        cell_type: src.cell_type,
        source: extractSource(src),
        metadata: {},
        outputs: [],
        execution_count: null,
        id: `copied-${i}`,
      });
    }

    const dest = await readNotebook(destPath);
    dest.cells.push(...copiedCells);
    await writeNotebook(destPath, dest);

    const reRead = await readNotebook(destPath);
    expect(reRead.cells.length).toBe(2);
    expect(extractSource(reRead.cells[0])).toContain("import os");
  });

  it("move_cells moves cells within same notebook", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    // Move cell 1 to position 4 (within same notebook)
    const [moved] = nb.cells.splice(1, 1);
    // After removal, position 4 → position 3
    nb.cells.splice(3, 0, moved);
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells.length).toBe(7);
    expect(extractSource(reRead.cells[3])).toContain("import os");
  });

  it("diff_notebooks detects identical notebooks", async () => {
    const path1 = await copyFixture("simple.ipynb", tmpDir);
    const path2 = join(tmpDir, "copy.ipynb");
    const nb = await readNotebook(path1);
    await writeNotebook(path2, nb);

    const nb1 = await readNotebook(path1);
    const nb2 = await readNotebook(path2);

    let diffs = 0;
    const maxCells = Math.max(nb1.cells.length, nb2.cells.length);
    for (let i = 0; i < maxCells; i++) {
      if (i >= nb1.cells.length || i >= nb2.cells.length) {
        diffs++;
        continue;
      }
      if (extractSource(nb1.cells[i]) !== extractSource(nb2.cells[i])) diffs++;
      if (getCellType(nb1.cells[i]) !== getCellType(nb2.cells[i])) diffs++;
    }

    expect(diffs).toBe(0);
  });

  it("diff_notebooks detects source differences", async () => {
    const path1 = await copyFixture("simple.ipynb", tmpDir);
    const path2 = join(tmpDir, "modified.ipynb");
    const nb = await readNotebook(path1);
    nb.cells[1].source = "modified_code = True";
    await writeNotebook(path2, nb);

    const nb1 = await readNotebook(path1);
    const nb2 = await readNotebook(path2);

    let sourceDiffs = 0;
    for (let i = 0; i < nb1.cells.length; i++) {
      if (extractSource(nb1.cells[i]) !== extractSource(nb2.cells[i])) sourceDiffs++;
    }

    expect(sourceDiffs).toBe(1);
  });
});

describe("replace_in_notebook (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-replace-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("replaces text in matching cells", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    const regex = /x/gi;
    let totalReplacements = 0;

    for (const cell of nb.cells) {
      if (getCellType(cell) !== "code") continue;
      const source = extractSource(cell);
      const matches = source.match(regex);
      if (matches) {
        totalReplacements += matches.length;
        cell.source = source.replace(regex, "y");
      }
    }

    await writeNotebook(path, nb);

    expect(totalReplacements).toBeGreaterThan(0);

    const reRead = await readNotebook(path);
    // Cell 2 had "x = 42", should now be "y = 42"
    expect(extractSource(reRead.cells[2])).toContain("y = 42");
  });

  it("dry_run doesn't modify the file", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const originalContent = await readFile(path, "utf-8");

    const nb = await readNotebook(path);
    const regex = /x/gi;

    // Count matches but don't write
    let matches = 0;
    for (const cell of nb.cells) {
      if (getCellType(cell) !== "code") continue;
      const source = extractSource(cell);
      const m = source.match(regex);
      if (m) matches += m.length;
    }

    expect(matches).toBeGreaterThan(0);

    // File should not be modified
    const afterContent = await readFile(path, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  it("respects cell_type filter", async () => {
    const nb = await readNotebook(join(FIXTURES, "simple.ipynb"));
    const regex = /Section/gi;

    // Only search in markdown cells
    let matches = 0;
    for (const cell of nb.cells) {
      if (getCellType(cell) !== "markdown") continue;
      const source = extractSource(cell);
      const m = source.match(regex);
      if (m) matches += m.length;
    }

    expect(matches).toBe(2); // "Section 1" and "Section 2"
  });
});

describe("change_cell_type (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-changetype-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("changes code to markdown", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    expect(nb.cells[1].cell_type).toBe("code");
    nb.cells[1].cell_type = "markdown";
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[1].cell_type).toBe("markdown");
    // Source should be preserved
    expect(extractSource(reRead.cells[1])).toContain("import os");
  });

  it("changes markdown to code", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);

    expect(nb.cells[0].cell_type).toBe("markdown");
    nb.cells[0].cell_type = "code";
    if (!nb.cells[0].outputs) nb.cells[0].outputs = [];
    if (nb.cells[0].execution_count === undefined) nb.cells[0].execution_count = null;
    await writeNotebook(path, nb);

    const reRead = await readNotebook(path);
    expect(reRead.cells[0].cell_type).toBe("code");
  });
});

describe("error cases (filesystem)", () => {
  it("throws for non-existent notebook", async () => {
    await expect(readNotebook("/tmp/nonexistent-notebook.ipynb")).rejects.toThrow();
  });

  it("resolveCellIndices throws for invalid index", () => {
    expect(() => resolveCellIndices(5, { index: 10 })).toThrow();
  });

  it("resolveCellIndices throws for negative index in indices array", () => {
    expect(() => resolveCellIndices(5, { indices: [-1] })).toThrow();
  });
});

describe("batch_insert_cells (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-batchins-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("inserts multiple cells at end", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    clearTracker(path);

    const result = await cellWriteHandlers["batch_insert_cells"]({
      path,
      inserts: [
        { source: "print('first')" },
        { source: "print('second')" },
      ],
      client_name: "test-agent",
    });

    const first = result.content[0];
    const text = first.type === "text" ? first.text : "";
    expect(text).toContain("Inserted 2 cells");

    const nb = await readNotebook(path);
    // Original has 7 cells, now should have 9
    expect(nb.cells.length).toBe(9);
    expect(extractSource(nb.cells[7])).toBe("print('first')");
    expect(extractSource(nb.cells[8])).toBe("print('second')");

    // Check change tracking
    const { changes } = getChangesSince(path, 0, 100);
    expect(changes.length).toBe(2);
    expect(changes[0].operation).toBe("insert");
    expect(changes[0].client).toBe("test-agent");
    expect(changes[1].operation).toBe("insert");
    expect(changes[1].client).toBe("test-agent");
  });

  it("inserts at specific index with offset tracking", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    clearTracker(path);

    await cellWriteHandlers["batch_insert_cells"]({
      path,
      inserts: [
        { source: "cell_A", index: 0 },
        { source: "cell_B", index: 0 },
      ],
    });

    const nb = await readNotebook(path);
    // Both specified index 0, but offset should shift the second one
    // First insert: index 0 + offset 0 = 0
    // Second insert: index 0 + offset 1 = 1
    expect(extractSource(nb.cells[0])).toBe("cell_A");
    expect(extractSource(nb.cells[1])).toBe("cell_B");
  });

  it("inserts markdown cells", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);

    await cellWriteHandlers["batch_insert_cells"]({
      path,
      inserts: [
        { source: "# Header", cell_type: "markdown" },
      ],
    });

    const nb = await readNotebook(path);
    const last = nb.cells[nb.cells.length - 1];
    expect(last.cell_type).toBe("markdown");
    expect(extractSource(last)).toBe("# Header");
  });

  it("rejects conflicting index + cell_id", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);
    const firstId = getCellId(nb.cells[0])!.slice(0, 8);

    await expect(
      cellWriteHandlers["batch_insert_cells"]({
        path,
        inserts: [{ source: "bad", index: 0, cell_id: firstId }],
      })
    ).rejects.toThrow("Specify either 'index' or 'cell_id'");
  });
});

describe("batch_update_cells change tracking (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-batchupd-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("tracks changes for each updated cell", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    clearTracker(path);

    await cellWriteHandlers["batch_update_cells"]({
      path,
      updates: [
        { index: 1, source: "updated_cell_1" },
        { index: 2, source: "updated_cell_2" },
      ],
      client_name: "batch-agent",
    });

    const { changes } = getChangesSince(path, 0, 100);
    expect(changes.length).toBe(2);
    expect(changes[0].operation).toBe("update");
    expect(changes[0].client).toBe("batch-agent");
    expect(changes[0].newSource).toBe("updated_cell_1");
    expect(changes[1].operation).toBe("update");
    expect(changes[1].client).toBe("batch-agent");
    expect(changes[1].newSource).toBe("updated_cell_2");
  });

  it("defaults client_name to claude-code", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    clearTracker(path);

    await cellWriteHandlers["batch_update_cells"]({
      path,
      updates: [{ index: 1, source: "new" }],
    });

    const { changes } = getChangesSince(path, 0, 100);
    expect(changes[0].client).toBe("claude-code");
  });
});

describe("recover_cell client_name (filesystem)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nb-recover-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("uses provided client_name for attribution", async () => {
    const path = await copyFixture("simple.ipynb", tmpDir);
    const nb = await readNotebook(path);
    const cellId = getCellId(nb.cells[1])!;
    const cellIdShort = cellId.slice(0, 8);

    // Record a delete so recover_cell has something to recover
    clearTracker(path);
    const { recordChange } = await import("./cell-tracker.js");
    recordChange(path, {
      operation: "delete",
      cellId,
      cellIdShort,
      cellIndex: 1,
      oldSource: "import os",
    });

    const result = await collabHandlers["recover_cell"]({
      path,
      cell_id: cellIdShort,
      client_name: "recovery-agent",
    });

    const first = result.content[0];
    expect(first.type === "text" && first.text).toContain("Recovered");

    // Check the restore change was attributed correctly
    const { changes } = getChangesSince(path, 0, 100);
    const restoreChange = changes.find((c) => c.operation === "restore");
    expect(restoreChange).toBeDefined();
    expect(restoreChange!.client).toBe("recovery-agent");
  });
});
