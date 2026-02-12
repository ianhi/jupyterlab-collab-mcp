import { describe, it, expect } from "vitest";
import {
  generateListVariablesCode,
  generateInspectVariablesCode,
  formatBasicOutput,
  formatSchemaOutput,
  formatFullOutput,
  formatOneInspection,
} from "./variable-inspector.js";

describe("generateListVariablesCode", () => {
  it("produces valid Python with default options", () => {
    const code = generateListVariablesCode({});
    expect(code).toContain("list_user_variables");
    expect(code).toContain('detail="basic"');
    expect(code).toContain("max_variables=50");
    expect(code).toContain("max_items=20");
    // Should NOT include filter or private by default
    expect(code).not.toContain("filter_name=");
    expect(code).not.toContain("include_private=True");
  });

  it("includes filter_name when specified", () => {
    const code = generateListVariablesCode({ filterName: "df" });
    expect(code).toContain('filter_name="df"');
  });

  it("includes include_private when true", () => {
    const code = generateListVariablesCode({ includePrivate: true });
    expect(code).toContain("include_private=True");
  });

  it("passes schema detail level", () => {
    const code = generateListVariablesCode({ detail: "schema" });
    expect(code).toContain('detail="schema"');
  });

  it("passes custom max values", () => {
    const code = generateListVariablesCode({ maxVariables: 100, maxItems: 5 });
    expect(code).toContain("max_variables=100");
    expect(code).toContain("max_items=5");
  });

  it("contains the inspector source code", () => {
    const code = generateListVariablesCode({});
    // Should embed the actual inspector module
    expect(code).toContain("def inspect_one(");
    expect(code).toContain("def summarize_one(");
    expect(code).toContain("def list_user_variables(");
  });

  it("includes cleanup block", () => {
    const code = generateListVariablesCode({});
    expect(code).toContain("_vi_");
    expect(code).toContain("del globals()");
  });
});

describe("generateInspectVariablesCode", () => {
  it("produces valid Python for given variable names", () => {
    const code = generateInspectVariablesCode({ names: ["df", "arr"] });
    expect(code).toContain("inspect_one");
    expect(code).toContain('"df"');
    expect(code).toContain('"arr"');
  });

  it("rejects invalid variable names", () => {
    expect(() => generateInspectVariablesCode({ names: ["foo.bar"] })).toThrow(
      "Invalid variable name"
    );
    expect(() => generateInspectVariablesCode({ names: ["1bad"] })).toThrow(
      "Invalid variable name"
    );
    expect(() =>
      generateInspectVariablesCode({ names: ["x; import os"] })
    ).toThrow("Invalid variable name");
  });

  it("passes max_items", () => {
    const code = generateInspectVariablesCode({
      names: ["x"],
      maxItems: 5,
    });
    expect(code).toContain("max_items=5");
  });

  it("includes cleanup block", () => {
    const code = generateInspectVariablesCode({ names: ["x"] });
    expect(code).toContain("_vi_");
    expect(code).toContain("del globals()");
  });
});

describe("formatBasicOutput", () => {
  it("formats variables list", () => {
    const vars = [
      { name: "df", type: "DataFrame", repr: "DataFrame(10x3)" },
      { name: "n", type: "int", repr: "42" },
    ];
    const text = formatBasicOutput("notebook.ipynb", vars);
    expect(text).toContain("Variables in notebook.ipynb (2)");
    expect(text).toContain("df: DataFrame = DataFrame(10x3)");
    expect(text).toContain("n: int = 42");
  });

  it("handles empty list", () => {
    expect(formatBasicOutput("nb.ipynb", [])).toContain("No user-defined variables");
  });

  it("shows filter in empty message", () => {
    expect(formatBasicOutput("nb.ipynb", [], "df")).toContain('matching "df"');
  });
});

describe("formatSchemaOutput", () => {
  it("formats schema summaries", () => {
    const summaries = [
      "df: DataFrame (1000x5) [id:int64, name:object]",
      "arr: ndarray float64 (100, 50) 0.38MB",
    ];
    const text = formatSchemaOutput("nb.ipynb", summaries);
    expect(text).toContain("schema mode");
    expect(text).toContain("df: DataFrame");
    expect(text).toContain("arr: ndarray");
  });

  it("handles empty list", () => {
    expect(formatSchemaOutput("nb.ipynb", [])).toContain("No user-defined variables");
  });
});

describe("formatFullOutput", () => {
  it("formats full inspections", () => {
    const inspections = [
      { name: "df", type: "DataFrame", shape: [10, 3], columns: [{ name: "id", dtype: "int64" }] },
    ];
    const text = formatFullOutput("nb.ipynb", inspections);
    expect(text).toContain("full mode");
    expect(text).toContain("## df");
    expect(text).toContain("id:int64");
  });
});

describe("formatOneInspection", () => {
  it("formats DataFrame inspection", () => {
    const info = {
      name: "df",
      type: "DataFrame",
      shape: [1000, 5],
      columns: [
        { name: "id", dtype: "int64" },
        { name: "name", dtype: "object" },
      ],
      memory_bytes: 40960,
    };
    const text = formatOneInspection(info);
    expect(text).toContain("## df");
    expect(text).toContain("DataFrame");
    expect(text).toContain("shape: [1000,5]");
    expect(text).toContain("id:int64");
    expect(text).toContain("name:object");
    expect(text).toContain("memory: 40.0KB");
  });

  it("formats dict inspection", () => {
    const info = {
      name: "config",
      type: "dict",
      length: 3,
      keys: ["host", "port", "db"],
      values_preview: { host: "str: 'localhost'", port: "int: 8080" },
    };
    const text = formatOneInspection(info);
    expect(text).toContain("## config");
    expect(text).toContain("keys: [host, port, db]");
    expect(text).toContain("host: str: 'localhost'");
  });

  it("formats scalar", () => {
    const info = { name: "n", type: "int", value: "42" };
    const text = formatOneInspection(info);
    expect(text).toContain("## n");
    expect(text).toContain("value: 42");
  });

  it("formats ndarray", () => {
    const info = {
      name: "arr",
      type: "ndarray",
      shape: [100, 50],
      nbytes: 40000,
    };
    const text = formatOneInspection(info);
    expect(text).toContain("## arr");
    expect(text).toContain("ndarray");
    expect(text).toContain("nbytes: 39.1KB");
  });

  it("formats xarray Dataset", () => {
    const info = {
      name: "ds",
      type: "xarray.Dataset",
      dims: { time: 365, x: 100 },
      data_vars: ["temp", "precip"],
    };
    const text = formatOneInspection(info);
    expect(text).toContain("## ds");
    expect(text).toContain("time:365");
    expect(text).toContain("data_vars: [temp, precip]");
  });

  it("formats error result", () => {
    const info = { name: "missing", error: "not defined" };
    const text = formatOneInspection(info);
    expect(text).toContain("## missing");
    expect(text).toContain("ERROR: not defined");
  });

  it("formats truncated columns", () => {
    const info = {
      name: "wide",
      type: "DataFrame",
      shape: [100, 200],
      columns: [{ name: "c0", dtype: "float64" }],
      columns_truncated: 200,
    };
    const text = formatOneInspection(info);
    expect(text).toContain("200 total columns");
  });

  it("formats DataTree children", () => {
    const info = {
      name: "tree",
      type: "xarray.DataTree",
      children: ["north", "south"],
    };
    const text = formatOneInspection(info);
    expect(text).toContain("children: [north, south]");
  });
});
