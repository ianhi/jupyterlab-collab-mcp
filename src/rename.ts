/**
 * Scope-aware rename for Python symbols in notebooks.
 * Uses jedi (via uvx or system python) to understand Python semantics.
 */

import { spawn } from "child_process";
import { type NotebookCell } from "./notebook-fs.js";
import { getCellType, extractSource } from "./helpers.js";

/** Maps a code cell to its position in the virtual file */
export interface CellOffset {
  cellIndex: number;
  startLine: number; // 1-indexed (jedi convention)
  lineCount: number;
}

/** A single cell edit produced by rename */
export interface RenameEdit {
  cellIndex: number;
  oldSource: string;
  newSource: string;
}

/** Result of a rename operation */
export interface RenameResult {
  edits: RenameEdit[];
  oldName: string;
  newName: string;
}

/**
 * Concatenate code cells into a virtual .py file.
 * Markdown cells are skipped. Returns the combined source and
 * a mapping table from virtual-file lines back to cells.
 */
export function buildVirtualFile(cells: { cell_type: string; source: string }[]): {
  source: string;
  offsets: CellOffset[];
} {
  const parts: string[] = [];
  const offsets: CellOffset[] = [];
  let currentLine = 1; // jedi is 1-indexed

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (getCellType(cell) !== "code") continue;

    const src = typeof cell.source === "string"
      ? cell.source
      : (cell.source as any).join?.("") ?? String(cell.source);

    const lines = src.split("\n");
    offsets.push({
      cellIndex: i,
      startLine: currentLine,
      lineCount: lines.length,
    });

    parts.push(src);
    currentLine += lines.length;
  }

  return {
    source: parts.join("\n"),
    offsets,
  };
}

/**
 * Given the original cells and jedi's changed source,
 * diff against the virtual file to find which cells changed.
 */
export function mapChangesBack(
  cells: { cell_type: string; source: string }[],
  changedSource: string,
  offsets: CellOffset[]
): RenameEdit[] {
  const changedLines = changedSource.split("\n");
  const edits: RenameEdit[] = [];

  for (const offset of offsets) {
    const cellLines = changedLines.slice(
      offset.startLine - 1,
      offset.startLine - 1 + offset.lineCount
    );
    const newSource = cellLines.join("\n");
    const oldSource = typeof cells[offset.cellIndex].source === "string"
      ? cells[offset.cellIndex].source
      : (cells[offset.cellIndex].source as any).join?.("") ?? String(cells[offset.cellIndex].source);

    if (newSource !== oldSource) {
      edits.push({
        cellIndex: offset.cellIndex,
        oldSource,
        newSource,
      });
    }
  }

  return edits;
}

/**
 * Convert a cell index + local line/column to virtual file line/column.
 * cellIndex is the notebook cell index (including markdown cells).
 * line is 0-indexed within the cell, character is 0-indexed.
 * Returns 1-indexed line and 0-indexed column for jedi.
 */
export function toVirtualPosition(
  offsets: CellOffset[],
  cellIndex: number,
  line: number,
  character: number
): { line: number; column: number } {
  const offset = offsets.find((o) => o.cellIndex === cellIndex);
  if (!offset) {
    throw new Error(
      `Cell ${cellIndex} is not a code cell or does not exist. ` +
      `Code cells at indices: ${offsets.map((o) => o.cellIndex).join(", ")}`
    );
  }
  if (line < 0 || line >= offset.lineCount) {
    throw new Error(
      `Line ${line} is out of range for cell ${cellIndex} (has ${offset.lineCount} lines)`
    );
  }
  return {
    line: offset.startLine + line, // 1-indexed
    column: character, // 0-indexed
  };
}

// Cache the resolved jedi command
let cachedJediCommand: string[] | null = null;

/** Try running a command and return true if it succeeds */
async function tryCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "pipe", timeout: 10000 });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Find the best way to invoke jedi.
 * Tries: uvx --from jedi, then python3 -c "import jedi".
 */
export async function findJediCommand(): Promise<string[]> {
  if (cachedJediCommand) return cachedJediCommand;

  // Try uvx first
  if (await tryCommand("uvx", ["--from", "jedi", "python3", "-c", "import jedi"])) {
    cachedJediCommand = ["uvx", "--from", "jedi", "python3"];
    return cachedJediCommand;
  }

  // Try system python3
  if (await tryCommand("python3", ["-c", "import jedi"])) {
    cachedJediCommand = ["python3"];
    return cachedJediCommand;
  }

  // Try python
  if (await tryCommand("python", ["-c", "import jedi"])) {
    cachedJediCommand = ["python"];
    return cachedJediCommand;
  }

  throw new Error(
    "jedi is not available. Install it with: pip install jedi\n" +
    "Or it will be auto-installed if you have uvx (from uv) available."
  );
}

/** Reset the cached command (for testing) */
export function resetJediCache(): void {
  cachedJediCommand = null;
}

// Python script that performs the rename via jedi
const JEDI_RENAME_SCRIPT = `
import sys, json

try:
    import jedi
except ImportError:
    print(json.dumps({"error": "jedi not installed"}))
    sys.exit(1)

source = sys.stdin.read()
args = json.loads(sys.argv[1])
line = args["line"]
column = args["column"]
new_name = args["new_name"]

script = jedi.Script(source)
try:
    refactoring = script.rename(line=line, column=column, new_name=new_name)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

# get_changed_files() returns {path: ChangedFile}
# For in-memory scripts the key is None
changed_files = refactoring.get_changed_files()
changed_file = changed_files.get(None)
if changed_file is None:
    # No changes
    print(json.dumps({"changed_code": source, "old_name": ""}))
    sys.exit(0)

changed_code = changed_file.get_new_code()

# Extract old name from the diff
old_name = ""
try:
    diff = refactoring.get_diff()
    for diff_line in diff.split("\\n"):
        if diff_line.startswith("-") and not diff_line.startswith("---"):
            # Find tokens that differ between - and + lines
            break
except Exception:
    pass

# Try to get old name by finding what was at the cursor position
try:
    names = script.get_names(all_scopes=True, references=True)
    for name in names:
        if name.line == line and name.column == column:
            old_name = name.name
            break
except Exception:
    pass

print(json.dumps({"changed_code": changed_code, "old_name": old_name}))
`;

/**
 * Spawn jedi subprocess to perform the rename.
 * Returns the changed source code string.
 */
export async function runJediRename(
  source: string,
  line: number,
  column: number,
  newName: string
): Promise<{ changedCode: string; oldName: string }> {
  const jediCmd = await findJediCommand();

  const args = JSON.stringify({ line, column, new_name: newName });
  const cmdArgs = [...jediCmd.slice(1), "-c", JEDI_RENAME_SCRIPT, args];

  return new Promise((resolve, reject) => {
    const proc = spawn(jediCmd[0], cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.stdin.write(source);
    proc.stdin.end();

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn jedi: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`jedi process exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(`jedi rename failed: ${result.error}`));
          return;
        }
        resolve({
          changedCode: result.changed_code,
          oldName: result.old_name || "",
        });
      } catch {
        reject(new Error(`Failed to parse jedi output: ${stdout}\nStderr: ${stderr}`));
      }
    });
  });
}

/**
 * Perform a scope-aware rename on a notebook's cells.
 * This is the main entry point used by both filesystem and Jupyter modes.
 *
 * @param cells - Array of cell objects with cell_type and source
 * @param cellIndex - Notebook cell index (includes markdown cells)
 * @param line - 0-indexed line within the cell
 * @param character - 0-indexed column within the line
 * @param newName - The new name for the symbol
 */
export async function renameSymbol(
  cells: { cell_type: string; source: string }[],
  cellIndex: number,
  line: number,
  character: number,
  newName: string
): Promise<RenameResult> {
  if (cellIndex < 0 || cellIndex >= cells.length) {
    throw new Error(`Cell index ${cellIndex} out of range (notebook has ${cells.length} cells)`);
  }

  if (getCellType(cells[cellIndex]) !== "code") {
    throw new Error(`Cell ${cellIndex} is not a code cell`);
  }

  const { source, offsets } = buildVirtualFile(cells);
  const { line: virtualLine, column } = toVirtualPosition(offsets, cellIndex, line, character);

  const { changedCode, oldName } = await runJediRename(source, virtualLine, column, newName);

  const edits = mapChangesBack(cells, changedCode, offsets);

  return {
    edits,
    oldName: oldName || "(unknown)",
    newName,
  };
}
