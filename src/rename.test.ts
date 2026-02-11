import { describe, it, expect, beforeEach } from "vitest";
import { join } from "path";
import {
  buildVirtualFile,
  mapChangesBack,
  toVirtualPosition,
  renameSymbol,
  runJediRename,
  findJediCommand,
  resetJediCache,
  type CellOffset,
} from "./rename.js";
import { readNotebook } from "./notebook-fs.js";

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

function makeCell(type: string, source: string) {
  return { cell_type: type, source, metadata: {} };
}

describe("buildVirtualFile", () => {
  it("concatenates code cells and skips markdown", () => {
    const cells = [
      makeCell("code", "import foo\nx = foo.bar()"),
      makeCell("markdown", "# Notes"),
      makeCell("code", "y = x + 1\nprint(y)"),
    ];

    const { source, offsets } = buildVirtualFile(cells);

    expect(source).toBe("import foo\nx = foo.bar()\ny = x + 1\nprint(y)");
    expect(offsets).toEqual([
      { cellIndex: 0, startLine: 1, lineCount: 2 },
      { cellIndex: 2, startLine: 3, lineCount: 2 },
    ]);
  });

  it("handles single cell", () => {
    const cells = [makeCell("code", "x = 1")];
    const { source, offsets } = buildVirtualFile(cells);

    expect(source).toBe("x = 1");
    expect(offsets).toEqual([{ cellIndex: 0, startLine: 1, lineCount: 1 }]);
  });

  it("handles empty notebook", () => {
    const { source, offsets } = buildVirtualFile([]);
    expect(source).toBe("");
    expect(offsets).toEqual([]);
  });

  it("handles only markdown cells", () => {
    const cells = [makeCell("markdown", "# Title"), makeCell("markdown", "text")];
    const { source, offsets } = buildVirtualFile(cells);
    expect(source).toBe("");
    expect(offsets).toEqual([]);
  });

  it("handles multi-line cells correctly", () => {
    const cells = [
      makeCell("code", "a = 1\nb = 2\nc = 3"),
      makeCell("code", "d = a + b"),
    ];
    const { source, offsets } = buildVirtualFile(cells);

    expect(offsets).toEqual([
      { cellIndex: 0, startLine: 1, lineCount: 3 },
      { cellIndex: 1, startLine: 4, lineCount: 1 },
    ]);
    expect(source.split("\n").length).toBe(4);
  });
});

describe("toVirtualPosition", () => {
  const offsets: CellOffset[] = [
    { cellIndex: 0, startLine: 1, lineCount: 2 },
    { cellIndex: 2, startLine: 3, lineCount: 2 },
  ];

  it("maps first cell, first line", () => {
    const pos = toVirtualPosition(offsets, 0, 0, 5);
    expect(pos).toEqual({ line: 1, column: 5 });
  });

  it("maps first cell, second line", () => {
    const pos = toVirtualPosition(offsets, 0, 1, 0);
    expect(pos).toEqual({ line: 2, column: 0 });
  });

  it("maps second code cell (index 2), first line", () => {
    const pos = toVirtualPosition(offsets, 2, 0, 3);
    expect(pos).toEqual({ line: 3, column: 3 });
  });

  it("throws for markdown cell", () => {
    expect(() => toVirtualPosition(offsets, 1, 0, 0)).toThrow(/not a code cell/);
  });

  it("throws for out-of-range line", () => {
    expect(() => toVirtualPosition(offsets, 0, 5, 0)).toThrow(/out of range/);
  });
});

describe("mapChangesBack", () => {
  it("detects changes in multiple cells", () => {
    const cells = [
      makeCell("code", "import foo\nx = foo.bar()"),
      makeCell("markdown", "# Notes"),
      makeCell("code", "y = x + 1\nprint(y)"),
    ];
    const offsets: CellOffset[] = [
      { cellIndex: 0, startLine: 1, lineCount: 2 },
      { cellIndex: 2, startLine: 3, lineCount: 2 },
    ];

    // Simulate renaming x → z
    const changedSource = "import foo\nz = foo.bar()\ny = z + 1\nprint(y)";
    const edits = mapChangesBack(cells, changedSource, offsets);

    expect(edits).toHaveLength(2);
    expect(edits[0].cellIndex).toBe(0);
    expect(edits[0].newSource).toBe("import foo\nz = foo.bar()");
    expect(edits[1].cellIndex).toBe(2);
    expect(edits[1].newSource).toBe("y = z + 1\nprint(y)");
  });

  it("returns empty array when nothing changed", () => {
    const cells = [makeCell("code", "x = 1")];
    const offsets: CellOffset[] = [{ cellIndex: 0, startLine: 1, lineCount: 1 }];

    const edits = mapChangesBack(cells, "x = 1", offsets);
    expect(edits).toEqual([]);
  });

  it("handles change in only one cell", () => {
    const cells = [
      makeCell("code", "x = 1"),
      makeCell("code", "y = 2"),
    ];
    const offsets: CellOffset[] = [
      { cellIndex: 0, startLine: 1, lineCount: 1 },
      { cellIndex: 1, startLine: 2, lineCount: 1 },
    ];

    const changedSource = "z = 1\ny = 2";
    const edits = mapChangesBack(cells, changedSource, offsets);

    expect(edits).toHaveLength(1);
    expect(edits[0].cellIndex).toBe(0);
    expect(edits[0].newSource).toBe("z = 1");
  });
});

// Integration tests - these require jedi to be available
describe("runJediRename", () => {
  let jediAvailable = false;

  beforeEach(async () => {
    resetJediCache();
    try {
      await findJediCommand();
      jediAvailable = true;
    } catch {
      jediAvailable = false;
    }
  });

  it.skipIf(!true)("renames a simple variable", async () => {
    // This test will be skipped at runtime if jedi is not available
    // (the skipIf check is done inside)
    try {
      await findJediCommand();
    } catch {
      return; // skip if jedi not available
    }

    const source = "x = 1\nprint(x)";
    const result = await runJediRename(source, 1, 0, "y");

    expect(result.changedCode).toBe("y = 1\nprint(y)");
  });

  it("rejects for non-symbol position", async () => {
    try {
      await findJediCommand();
    } catch {
      return;
    }

    const source = "x = 1";
    // Column 2 is on "=" which is not a symbol
    await expect(runJediRename(source, 1, 2, "y")).rejects.toThrow();
  });
});

describe("renameSymbol", () => {
  beforeEach(() => {
    resetJediCache();
  });

  it("renames across cells", async () => {
    try {
      await findJediCommand();
    } catch {
      return; // skip if jedi not available
    }

    const cells = [
      makeCell("code", "x = 1"),
      makeCell("markdown", "# Notes about x"),
      makeCell("code", "print(x)"),
    ];

    const result = await renameSymbol(cells, 0, 0, 0, "my_var");

    expect(result.newName).toBe("my_var");
    expect(result.edits.length).toBeGreaterThanOrEqual(1);

    // Both code cells should be modified
    const cellIndices = result.edits.map((e) => e.cellIndex);
    expect(cellIndices).toContain(0);
    expect(cellIndices).toContain(2);

    // Verify the rename
    for (const edit of result.edits) {
      expect(edit.newSource).toContain("my_var");
      expect(edit.newSource).not.toContain("x");
    }
  });

  it("does not rename in strings or comments", async () => {
    try {
      await findJediCommand();
    } catch {
      return;
    }

    const cells = [
      makeCell("code", 'x = 1\n# x is a variable\nprint("x =", x)'),
    ];

    const result = await renameSymbol(cells, 0, 0, 0, "val");

    expect(result.edits).toHaveLength(1);
    const newSource = result.edits[0].newSource;
    // The variable references should be renamed
    expect(newSource).toContain("val = 1");
    expect(newSource).toContain(", val)");
    // The string literal "x =" should NOT be renamed
    expect(newSource).toContain('"x ="');
  });

  it("throws for markdown cell", async () => {
    const cells = [makeCell("markdown", "# Title")];
    await expect(renameSymbol(cells, 0, 0, 0, "new")).rejects.toThrow(/not a code cell/);
  });

  it("throws for out-of-range cell index", async () => {
    const cells = [makeCell("code", "x = 1")];
    await expect(renameSymbol(cells, 5, 0, 0, "new")).rejects.toThrow(/out of range/);
  });

  it("works with rename-test fixture", async () => {
    try {
      await findJediCommand();
    } catch {
      return;
    }

    const nb = await readNotebook(join(FIXTURES, "rename-test.ipynb"));
    // Rename 'df' at cell 2 (index 2), line 0, col 0
    const result = await renameSymbol(
      nb.cells as { cell_type: string; source: string }[],
      2, 0, 0, "data_frame"
    );

    expect(result.newName).toBe("data_frame");
    expect(result.edits.length).toBeGreaterThanOrEqual(1);

    // df should be renamed in cells 2 and 3
    const editIndices = result.edits.map((e) => e.cellIndex);
    expect(editIndices).toContain(2);
    expect(editIndices).toContain(3);

    // Check cell 3 has both occurrences renamed
    const cell3Edit = result.edits.find((e) => e.cellIndex === 3);
    expect(cell3Edit).toBeDefined();
    expect(cell3Edit!.newSource).toContain("data_frame.groupby");
    expect(cell3Edit!.newSource).toContain("data_frame.shape");
    expect(cell3Edit!.newSource).not.toContain("df.");
  });
});
