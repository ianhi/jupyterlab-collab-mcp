/**
 * Variable inspector: embeds Python code for fast, safe kernel variable introspection.
 *
 * The Python source lives in python/src/variable_inspector/inspector.py and is
 * embedded here as a string constant. At runtime it is injected into the kernel
 * as a one-shot script (no permanent side effects — all helpers are cleaned up).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Embedded Python source
// ---------------------------------------------------------------------------

let _cachedInspectorSource: string | null = null;

function getInspectorSource(): string {
  if (_cachedInspectorSource) return _cachedInspectorSource;

  // Try to read from the python/ directory relative to this file's location.
  // Works in both dev (src/) and built (dist/) layouts.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, "..", "python", "src", "variable_inspector", "inspector.py"),
    join(thisDir, "inspector.py"), // fallback: bundled alongside dist
  ];

  for (const p of candidates) {
    try {
      _cachedInspectorSource = readFileSync(p, "utf-8");
      return _cachedInspectorSource;
    } catch {
      // try next
    }
  }

  throw new Error(
    "Could not find inspector.py. Expected at python/src/variable_inspector/inspector.py"
  );
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

/**
 * Generate Python code for `get_kernel_variables` with a given detail level.
 *
 * detail = "basic"  → current behavior (name, type, repr)
 * detail = "schema" → one-line summaries via summarize_one()
 * detail = "full"   → full inspect_one() dicts
 */
export function generateListVariablesCode(opts: {
  detail?: string;
  maxVariables?: number;
  maxItems?: number;
  maxNameLength?: number | null;
  filterName?: string;
  includePrivate?: boolean;
}): string {
  const {
    detail = "basic",
    maxVariables = 50,
    maxItems = 20,
    maxNameLength = 60,
    filterName,
    includePrivate = false,
  } = opts;

  const filterArg = filterName ? `, filter_name=${JSON.stringify(filterName)}` : "";
  const privateArg = includePrivate ? ", include_private=True" : "";
  const nameLengthArg = maxNameLength === null ? "None" : maxNameLength;

  return `
# --- variable inspector (ephemeral) ---
${getInspectorSource()}

import json as _vi_json

_vi_ns = {_vi_k: _vi_v for _vi_k, _vi_v in globals().items()}
_vi_result = list_user_variables(
    _vi_ns,
    detail=${JSON.stringify(detail)},
    max_variables=${maxVariables},
    max_items=${maxItems},
    max_name_length=${nameLengthArg}${filterArg}${privateArg},
)
print(_vi_json.dumps(_vi_result, default=str))

# cleanup
for _vi_k in list(globals()):
    if _vi_k.startswith("_vi_"):
        del globals()[_vi_k]
del globals()["inspect_one"], globals()["summarize_one"], globals()["list_user_variables"]
`;
}

/**
 * Generate Python code for `inspect_variable` on specific variable names.
 */
export function generateInspectVariablesCode(opts: {
  names: string[];
  maxItems?: number;
  maxNameLength?: number | null;
}): string {
  const { names, maxItems = 20, maxNameLength = 60 } = opts;

  // Validate names to prevent injection
  for (const name of names) {
    if (!/^[a-zA-Z_]\w*$/.test(name)) {
      throw new Error(`Invalid variable name: ${JSON.stringify(name)}`);
    }
  }

  const namesList = names.map((n) => JSON.stringify(n)).join(", ");
  const nameLengthArg = maxNameLength === null ? "None" : maxNameLength;

  return `
# --- variable inspector (ephemeral) ---
${getInspectorSource()}

import json as _vi_json

_vi_names = [${namesList}]
_vi_results = []
for _vi_name in _vi_names:
    try:
        _vi_obj = eval(_vi_name)
        _vi_results.append(inspect_one(_vi_name, _vi_obj, max_items=${maxItems}, max_name_length=${nameLengthArg}))
    except NameError:
        _vi_results.append({"name": _vi_name, "error": "not defined"})
    except Exception as _vi_e:
        _vi_results.append({"name": _vi_name, "error": str(_vi_e)})
print(_vi_json.dumps(_vi_results, default=str))

# cleanup
for _vi_k in list(globals()):
    if _vi_k.startswith("_vi_"):
        del globals()[_vi_k]
del globals()["inspect_one"], globals()["summarize_one"], globals()["list_user_variables"]
`;
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/**
 * Format schema-mode output (list of one-line summary strings) into a
 * human-readable block.
 */
export function formatSchemaOutput(
  path: string,
  summaries: string[],
): string {
  if (summaries.length === 0) {
    return `No user-defined variables in ${path}`;
  }
  const lines = [`Variables in ${path} (${summaries.length}, schema mode):\n`];
  for (const s of summaries) {
    lines.push(`  ${s}`);
  }
  return lines.join("\n");
}

/**
 * Format basic-mode output (list of {name, type, repr} dicts).
 */
export function formatBasicOutput(
  path: string,
  vars: { name: string; type: string; repr: string }[],
  filter?: string,
): string {
  if (vars.length === 0) {
    return filter
      ? `No variables matching "${filter}" in ${path}`
      : `No user-defined variables in ${path}`;
  }
  const lines = [`Variables in ${path} (${vars.length}):\n`];
  for (const v of vars) {
    lines.push(`  ${v.name}: ${v.type} = ${v.repr}`);
  }
  return lines.join("\n");
}

/**
 * Format full-mode output (list of inspect_one dicts) into structured text.
 */
export function formatFullOutput(
  path: string,
  inspections: Record<string, unknown>[],
): string {
  if (inspections.length === 0) {
    return `No user-defined variables in ${path}`;
  }
  const lines = [`Variables in ${path} (${inspections.length}, full mode):\n`];
  for (const info of inspections) {
    lines.push(formatOneInspection(info));
  }
  return lines.join("\n");
}

/**
 * Format a single inspect_one result into readable text.
 */
export function formatOneInspection(info: Record<string, unknown>): string {
  const name = info.name as string;
  const type = info.type as string;
  const parts: string[] = [];

  parts.push(`## ${name}`);
  parts.push(`${type}`);

  // Shape/size info
  if (info.shape) parts.push(`  shape: ${JSON.stringify(info.shape)}`);
  if (info.length !== undefined) parts.push(`  length: ${info.length}`);

  // Columns (DataFrames)
  if (Array.isArray(info.columns)) {
    const cols = info.columns as { name: string; dtype: string }[];
    const colStrs = cols.map((c) => `${c.name}:${c.dtype}`);
    parts.push(`  columns: [${colStrs.join(", ")}]`);
    if (info.columns_truncated) {
      parts.push(`  (${info.columns_truncated} total columns)`);
    }
  }

  // Dict keys
  if (Array.isArray(info.keys)) {
    parts.push(`  keys: [${(info.keys as string[]).join(", ")}]`);
    if (info.keys_truncated) parts.push(`  (${info.keys_truncated} total keys)`);
  }

  // Values preview
  if (info.values_preview) {
    const vp = info.values_preview as Record<string, string>;
    for (const [k, v] of Object.entries(vp)) {
      parts.push(`    ${k}: ${v}`);
    }
  }

  // xarray dims/vars
  if (info.dims && typeof info.dims === "object" && !Array.isArray(info.dims)) {
    const dims = info.dims as Record<string, number>;
    parts.push(`  dims: ${Object.entries(dims).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  if (Array.isArray(info.data_vars)) {
    parts.push(`  data_vars: [${(info.data_vars as string[]).join(", ")}]`);
  }

  // DataTree children
  if (Array.isArray(info.children)) {
    parts.push(`  children: [${(info.children as string[]).join(", ")}]`);
  }

  // Memory
  if (info.memory_bytes) parts.push(`  memory: ${formatBytes(info.memory_bytes as number)}`);
  if (info.estimated_size_bytes) parts.push(`  estimated_size: ${formatBytes(info.estimated_size_bytes as number)}`);
  if (info.nbytes) parts.push(`  nbytes: ${formatBytes(info.nbytes as number)}`);

  // Scalar value or repr
  if (info.value !== undefined) parts.push(`  value: ${info.value}`);
  if (info.repr !== undefined) parts.push(`  repr: ${info.repr}`);

  // Error
  if (info.error) parts.push(`  ERROR: ${info.error}`);

  return parts.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
