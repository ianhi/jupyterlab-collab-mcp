# Variable Inspector Test Results

**Date:** 2026-02-11
**Test:** Two haiku agents coordinating via kernel variables
**Notebook:** variable_inspector_test.ipynb

## Test Setup

- **data-loader agent** (haiku): Created sales dataset with 120 rows, 4 columns
- **analyzer agent** (haiku): Discovered data via `get_kernel_variables`, performed analysis
- **Coordination:** Agents worked in parallel, no explicit messaging required

## Results

### ✅ SUCCESSES

1. **`get_kernel_variables` worked perfectly**
   - Analyzer agent successfully used `detail="schema"` mode
   - Returned clean one-line summaries for all 28 kernel variables
   - Example output: `sales_df: DataFrame (120×4) [date:datetime64[ns], product:object, amount:float64, region:object]`
   - Schema mode provided sufficient information for agent to proceed with analysis

2. **Agent coordination via kernel state**
   - data-loader created `sales_df` and `data_status` dict
   - analyzer discovered variables without needing messaging
   - Both agents worked independently and successfully

3. **Change tracking and attribution**
   - All cells properly attributed via `client_name` parameter
   - Change log shows: 1 cell by team-lead, 1 by data-loader, 5 by analyzer
   - Cell IDs stable throughout test

4. **Analysis quality**
   - 5 comprehensive analysis cells created
   - Summary stats, groupby analysis, 4 visualizations
   - Key findings: Monitor top product ($27,422), West top region ($37,010)

### ❌ ISSUE FOUND

**`inspect_variable` tool not available**

```
Error: No such tool available: mcp__jupyter__inspect_variable
```

**Root cause:** Tool exists in code (`src/handlers/kernel-lsp.ts:156` and `src/schemas.ts:1208`) but server needs rebuild + restart for schema changes to take effect.

**Impact:** Analyzer agent fell back to using `get_kernel_variables(detail="schema")` which was sufficient, but we didn't test the deep inspection capability.

## Code Quality

**Python inspector.py (537 lines):**
- Clean separation: specialized inspectors for pandas/polars/numpy/xarray
- Safe: all operations wrapped in try/except, never triggers lazy computation
- Fast: relies on library repr() with structured extraction only for DataFrames/arrays
- Some duplication between pandas/polars inspectors (~80% similar logic)

**TypeScript integration:**
- Reads inspector.py at runtime, embeds as string in generated code
- Executes in kernel via `execute_code`, parses JSON output
- Ephemeral: cleans up all `_vi_*` variables and functions after execution
- Three output formatters: basic, schema (one-line), full (structured)

## Recommendations

1. **Rebuild + restart required:** Run `npm run build` and restart Claude Code to enable `inspect_variable` tool
2. **Re-test with `inspect_variable`:** Once available, test deep inspection of DataFrames, nested dicts, xarray Datasets
3. **Python consolidation (optional):** Could reduce ~100 lines by consolidating pandas/polars DataFrame inspectors, but current clarity is valuable
4. **Document the flow:** Add architecture diagram showing TypeScript → Python → JSON → TypeScript flow

## Notebook State

**Cells created:**
- Cell 0: Empty (initial)
- Cell 1: Setup imports (team-lead)
- Cell 2: Sales data creation (data-loader)
- Cell 3: Dataset overview (analyzer)
- Cell 4: Summary statistics (analyzer)
- Cell 5: Groupby analysis (analyzer)
- Cell 6: 4 visualizations (analyzer)
- Cell 7: Final report (analyzer)

**Variables in kernel:** 28 total including sales_df, data_status, matplotlib objects, intermediate results

## Conclusion

**Overall: PARTIAL SUCCESS**

The `get_kernel_variables` tool works excellently and enabled successful agent coordination. The `inspect_variable` tool exists but wasn't available due to server not being restarted after code changes. Once that's fixed, full testing can proceed.

**Next steps:**
1. `npm run build` + restart Claude Code
2. Re-run test with `inspect_variable` calls
3. Test with more complex data types (nested dicts, xarray Datasets, polars LazyFrames)
