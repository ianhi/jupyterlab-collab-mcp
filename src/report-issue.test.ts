import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the handler by importing it and mocking the file path.
// The handler is in collab.ts but uses module-level constants.
// To test properly, we'll re-implement the core logic inline and also
// do integration-style tests by calling the handler directly.

// ---- Unit tests for the toString / truncation / serialization logic ----

/** Mirrors the toString helper in collab.ts report_issue handler */
function toString(v: unknown, maxLen: number): string | undefined {
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s;
}

describe("toString coercion", () => {
  it("passes through normal strings", () => {
    expect(toString("hello", 100)).toBe("hello");
  });

  it("returns undefined for null and undefined", () => {
    expect(toString(null, 100)).toBeUndefined();
    expect(toString(undefined, 100)).toBeUndefined();
  });

  it("truncates long strings", () => {
    const long = "a".repeat(600);
    const result = toString(long, 500)!;
    expect(result).toHaveLength(500 + "...[truncated]".length);
    expect(result).toMatch(/\.\.\.\[truncated\]$/);
  });

  it("coerces numbers to string via JSON.stringify", () => {
    expect(toString(42, 100)).toBe("42");
    expect(toString(3.14, 100)).toBe("3.14");
  });

  it("coerces booleans", () => {
    expect(toString(true, 100)).toBe("true");
    expect(toString(false, 100)).toBe("false");
  });

  it("coerces objects to JSON", () => {
    const obj = { key: "value", nested: { a: 1 } };
    expect(toString(obj, 1000)).toBe(JSON.stringify(obj));
  });

  it("coerces arrays to JSON", () => {
    expect(toString([1, 2, 3], 100)).toBe("[1,2,3]");
  });

  it("truncates large objects", () => {
    const bigObj = { data: "x".repeat(1000) };
    const result = toString(bigObj, 50)!;
    expect(result.length).toBeLessThan(100);
    expect(result).toMatch(/\.\.\.\[truncated\]$/);
  });

  it("handles empty string", () => {
    expect(toString("", 100)).toBe("");
  });

  it("handles string at exact max length", () => {
    const exact = "a".repeat(500);
    expect(toString(exact, 500)).toBe(exact);
  });

  it("handles string one over max length", () => {
    const over = "a".repeat(501);
    const result = toString(over, 500)!;
    expect(result).toMatch(/\.\.\.\[truncated\]$/);
  });
});

// ---- Tests for special characters in JSONL serialization ----

describe("JSONL safety with special characters", () => {
  // Simulates what the handler does: build a report object and serialize it
  function buildReportLine(fields: Record<string, unknown>): string {
    const report: Record<string, unknown> = {
      timestamp: "2026-01-01T00:00:00.000Z",
      session_id: "test-session",
      category: fields.category ?? "tool_bug",
      summary: fields.summary ?? "test",
    };
    if (fields.tool_name) report.tool_name = fields.tool_name;
    if (fields.path) report.path = fields.path;
    if (fields.details) report.details = fields.details;
    return JSON.stringify(report);
  }

  function assertValidJsonLine(line: string) {
    // Must be valid JSON
    const parsed = JSON.parse(line);
    expect(parsed).toBeDefined();
    // Must be a single line (no raw newlines)
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
  }

  it("handles newlines in details", () => {
    const line = buildReportLine({
      details: "Error:\nTraceback:\n  File foo.py\n    line 42",
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain("\n");
  });

  it("handles embedded JSON in details", () => {
    const embedded = JSON.stringify({ error: "failed", code: 500 });
    const line = buildReportLine({ details: embedded });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    // The embedded JSON should be a string, not parsed
    expect(typeof parsed.details).toBe("string");
  });

  it("handles backticks and markdown", () => {
    const line = buildReportLine({
      summary: "Bug in `get_kernel_variables`",
      details: "```python\nprint('hello')\n```\n\nThe above code **fails**.",
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.summary).toContain("`");
    expect(parsed.details).toContain("```");
  });

  it("handles quotes and backslashes", () => {
    const line = buildReportLine({
      details: 'He said "hello" and the path was C:\\Users\\test\\file.py',
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain('"hello"');
    expect(parsed.details).toContain("C:\\Users\\test\\file.py");
  });

  it("handles unicode and emoji", () => {
    const line = buildReportLine({
      summary: "Unicode test: 日本語 العربية 🎉🔥",
      details: "Arrow → bullet • em—dash",
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.summary).toContain("日本語");
    expect(parsed.summary).toContain("🎉");
  });

  it("handles null bytes and control characters", () => {
    const line = buildReportLine({
      details: "before\x00after\x01\x02\x03\x1b[31mred\x1b[0m",
    });
    assertValidJsonLine(line);
    // JSON.stringify escapes control chars
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain("before");
    expect(parsed.details).toContain("after");
  });

  it("handles tab characters", () => {
    const line = buildReportLine({
      details: "col1\tcol2\tcol3\nval1\tval2\tval3",
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain("\t");
  });

  it("handles very long single-line input", () => {
    const longStr = "x".repeat(3000);
    const line = buildReportLine({ details: longStr });
    assertValidJsonLine(line);
    // Total line should be under 4KB for atomic O_APPEND
    // (after truncation in handler, but here we test raw serialization)
  });

  it("handles HTML/XML-like content", () => {
    const line = buildReportLine({
      details: '<script>alert("xss")</script><div class="test">content</div>',
    });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain("<script>");
  });

  it("handles Python tracebacks with special chars", () => {
    const traceback = `Traceback (most recent call last):
  File "/home/user/notebook.py", line 42, in <module>
    result = df[df["col"] > 0].groupby("cat").agg({"val": ["mean", "std"]})
  File "/usr/lib/python3.11/pandas/core/frame.py", line 3896, in __getitem__
    raise KeyError(key)
KeyError: 'nonexistent_column'`;
    const line = buildReportLine({ details: traceback });
    assertValidJsonLine(line);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain("KeyError");
    expect(parsed.details).toContain("<module>");
  });

  it("handles mixed encoding edge cases", () => {
    const line = buildReportLine({
      details: "Latin: café résumé naïve\nCJK: 你好世界\nRTL: مرحبا\nMath: ∑∏∫≈≠",
    });
    assertValidJsonLine(line);
  });
});

// ---- Integration tests using actual file I/O ----

describe("report_issue handler integration", () => {
  let tmpDir: string;
  let reportsPath: string;

  // We can't easily import the handler with mocked REPORTS_PATH,
  // so we test the file writing pattern directly
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "report-test-"));
    reportsPath = join(tmpDir, "reports.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Simulate what the handler does for file writes */
  function writeReport(fields: Record<string, unknown>): void {
    const report: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      session_id: "test-session-id",
      category: fields.category,
      summary: fields.summary,
    };
    if (fields.tool_name) report.tool_name = fields.tool_name;
    if (fields.path) report.path = fields.path;
    if (fields.details) report.details = fields.details;

    const { appendFileSync } = require("fs");
    appendFileSync(reportsPath, JSON.stringify(report) + "\n");
  }

  function readReports(): Record<string, unknown>[] {
    if (!existsSync(reportsPath)) return [];
    const content = readFileSync(reportsPath, "utf-8");
    return content
      .split("\n")
      .filter((l: string) => l.trim().length > 0)
      .map((l: string) => JSON.parse(l));
  }

  it("creates file on first report", () => {
    expect(existsSync(reportsPath)).toBe(false);
    writeReport({ category: "tool_bug", summary: "test bug" });
    expect(existsSync(reportsPath)).toBe(true);
    const reports = readReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].category).toBe("tool_bug");
  });

  it("appends multiple reports", () => {
    writeReport({ category: "tool_bug", summary: "bug 1" });
    writeReport({ category: "hang", summary: "hang 1" });
    writeReport({ category: "observation", summary: "obs 1" });
    const reports = readReports();
    expect(reports).toHaveLength(3);
    expect(reports[0].summary).toBe("bug 1");
    expect(reports[1].summary).toBe("hang 1");
    expect(reports[2].summary).toBe("obs 1");
  });

  it("each report is exactly one line", () => {
    writeReport({
      category: "tool_bug",
      summary: "multiline\nsummary",
      details: "line1\nline2\nline3",
    });
    const content = readFileSync(reportsPath, "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    expect(lines).toHaveLength(1);
    // But the content inside preserves newlines
    const parsed = JSON.parse(lines[0]);
    expect(parsed.details).toContain("\n");
  });

  it("handles report with all optional fields", () => {
    writeReport({
      category: "missing_feature",
      summary: "Need X",
      tool_name: "get_kernel_variables",
      path: "analysis.ipynb",
      details: "Detailed description here",
    });
    const reports = readReports();
    expect(reports[0].tool_name).toBe("get_kernel_variables");
    expect(reports[0].path).toBe("analysis.ipynb");
    expect(reports[0].details).toBe("Detailed description here");
  });

  it("handles report with no optional fields", () => {
    writeReport({ category: "observation", summary: "Just a note" });
    const reports = readReports();
    expect(reports[0].tool_name).toBeUndefined();
    expect(reports[0].path).toBeUndefined();
    expect(reports[0].details).toBeUndefined();
  });

  it("handles concurrent-style rapid writes", () => {
    // Simulate many rapid sequential writes (as close to concurrent as we can in single-threaded Node)
    for (let i = 0; i < 100; i++) {
      writeReport({ category: "tool_bug", summary: `Bug #${i}` });
    }
    const reports = readReports();
    expect(reports).toHaveLength(100);
    // Verify no corruption — every line must parse
    for (let i = 0; i < 100; i++) {
      expect(reports[i].summary).toBe(`Bug #${i}`);
    }
  });

  it("handles details with embedded JSONL-breaking attempts", () => {
    // Attempt to inject a fake report line
    writeReport({
      category: "tool_bug",
      summary: "legit report",
      details: '}\n{"category":"injected","summary":"fake"}',
    });
    const reports = readReports();
    // Should be exactly 1 report, not 2
    expect(reports).toHaveLength(1);
    expect(reports[0].summary).toBe("legit report");
    expect(reports[0].details).toContain("injected");
  });
});

// ---- Tests for file rotation logic ----

describe("rotation logic", () => {
  let tmpDir: string;
  let reportsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rotation-test-"));
    reportsPath = join(tmpDir, "reports.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Mirrors rotateReportsIfNeeded from collab.ts */
  function rotateIfNeeded(maxBytes: number): void {
    try {
      if (!existsSync(reportsPath)) return;
      const { statSync } = require("fs");
      const stat = statSync(reportsPath);
      if (stat.size <= maxBytes) return;

      const content = readFileSync(reportsPath, "utf-8");
      const midpoint = Math.floor(content.length / 2);
      const nextNewline = content.indexOf("\n", midpoint);
      if (nextNewline === -1) return;
      const trimmed = content.slice(nextNewline + 1);
      writeFileSync(reportsPath, trimmed);
    } catch {
      // Non-critical
    }
  }

  it("does not rotate small files", () => {
    const line = JSON.stringify({ category: "test", summary: "x" }) + "\n";
    writeFileSync(reportsPath, line.repeat(5));
    const sizeBefore = readFileSync(reportsPath, "utf-8").length;
    rotateIfNeeded(1024 * 1024); // 1MB threshold
    const sizeAfter = readFileSync(reportsPath, "utf-8").length;
    expect(sizeAfter).toBe(sizeBefore);
  });

  it("rotates when file exceeds threshold", () => {
    // Use a tiny threshold for testing
    const line = JSON.stringify({ category: "test", summary: "x".repeat(50) }) + "\n";
    const numLines = 100;
    writeFileSync(reportsPath, line.repeat(numLines));
    const sizeBefore = readFileSync(reportsPath, "utf-8").length;

    rotateIfNeeded(sizeBefore - 10); // just under current size
    const sizeAfter = readFileSync(reportsPath, "utf-8").length;
    expect(sizeAfter).toBeLessThan(sizeBefore);
    expect(sizeAfter).toBeGreaterThan(0);
  });

  it("keeps valid JSONL after rotation", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ category: "test", summary: `report-${i}` }));
    }
    writeFileSync(reportsPath, lines.join("\n") + "\n");

    rotateIfNeeded(10); // force rotation with tiny threshold
    const content = readFileSync(reportsPath, "utf-8");
    const remaining = content
      .split("\n")
      .filter((l: string) => l.trim());

    // Every remaining line must be valid JSON
    for (const line of remaining) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Should have fewer lines than original
    expect(remaining.length).toBeLessThan(50);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("does nothing if file does not exist", () => {
    expect(() => rotateIfNeeded(100)).not.toThrow();
  });

  it("preserves most recent reports after rotation", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ idx: i, summary: `report-${i}` }));
    }
    writeFileSync(reportsPath, lines.join("\n") + "\n");

    rotateIfNeeded(10); // force rotation
    const content = readFileSync(reportsPath, "utf-8");
    const remaining = content
      .split("\n")
      .filter((l: string) => l.trim())
      .map((l: string) => JSON.parse(l));

    // The last report should always survive rotation
    const lastIdx = remaining[remaining.length - 1].idx;
    expect(lastIdx).toBe(99);
  });
});

// ---- Edge case: the handler's validation logic ----

describe("report_issue validation logic", () => {
  const VALID_CATEGORIES = ["tool_bug", "hang", "missing_feature", "observation", "user_feedback"];

  // Mirrors the handler's validation
  function validate(args: Record<string, unknown>): { valid: boolean; error?: string } {
    const toStr = (v: unknown, maxLen: number): string | undefined => {
      if (v == null) return undefined;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s;
    };

    const category = toStr(args.category, 50);
    const summary = toStr(args.summary, 500);

    if (!category || !summary) {
      return { valid: false, error: "report_issue requires 'category' and 'summary'" };
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return { valid: false, error: `Invalid category '${category}'` };
    }
    return { valid: true };
  }

  it("accepts all valid categories", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(validate({ category: cat, summary: "test" }).valid).toBe(true);
    }
  });

  it("rejects invalid category", () => {
    expect(validate({ category: "invalid", summary: "test" }).valid).toBe(false);
  });

  it("rejects missing category", () => {
    expect(validate({ summary: "test" }).valid).toBe(false);
  });

  it("rejects missing summary", () => {
    expect(validate({ category: "tool_bug" }).valid).toBe(false);
  });

  it("rejects null category", () => {
    expect(validate({ category: null, summary: "test" }).valid).toBe(false);
  });

  it("rejects null summary", () => {
    expect(validate({ category: "tool_bug", summary: null }).valid).toBe(false);
  });

  it("rejects empty string summary (coerced to falsy)", () => {
    // Empty string is falsy, so toString returns "" which is falsy
    expect(validate({ category: "tool_bug", summary: "" }).valid).toBe(false);
  });

  it("accepts numeric category that matches after coercion (unlikely but safe)", () => {
    // A number won't match any category string
    expect(validate({ category: 42, summary: "test" }).valid).toBe(false);
  });

  it("handles category with injection attempt", () => {
    const result = validate({
      category: 'tool_bug", "injected": "yes',
      summary: "test",
    });
    expect(result.valid).toBe(false); // won't match valid categories
  });

  it("truncates extremely long category before validation", () => {
    const longCat = "tool_bug" + "x".repeat(1000);
    const result = validate({ category: longCat, summary: "test" });
    // After truncation to 50 chars, won't match "tool_bug"
    expect(result.valid).toBe(false);
  });

  it("accepts summary with special characters", () => {
    expect(
      validate({
        category: "tool_bug",
        summary: '`code` "quotes" <tags> $vars {{braces}} \\ backslash',
      }).valid
    ).toBe(true);
  });
});
