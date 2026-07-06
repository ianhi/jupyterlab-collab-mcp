import { describe, it, expect } from "vitest";
import { handlers } from "./handlers/guide.js";
import { toolSchemas } from "./schemas.js";

const guide = handlers.notebook_guide;

async function text(args: Record<string, unknown>): Promise<string> {
  const res = await guide(args);
  return res.content
    .map((c) => ("text" in c ? c.text : ""))
    .join("\n");
}

describe("notebook_guide", () => {
  it("is registered in the tool schemas with a topic enum", () => {
    const schema = toolSchemas.find((t) => t.name === "notebook_guide");
    expect(schema).toBeDefined();
    const topic = (schema!.inputSchema.properties as any).topic;
    expect(topic.enum).toContain("all");
    expect(topic.enum).toContain("troubleshooting");
    // No required args — callable with no input.
    expect((schema!.inputSchema as any).required).toBeUndefined();
  });

  it("returns the full guide when no topic is given", async () => {
    const out = await text({});
    expect(out).toContain("# Working with notebooks via this MCP");
    // Touches every section.
    for (const heading of [
      "## Orientation",
      "## Reading",
      "## Editing",
      "## Executing",
      "## Sharing",
      "## Troubleshooting",
    ]) {
      expect(out).toContain(heading);
    }
  });

  it("treats topic 'all' the same as omitting it", async () => {
    expect(await text({ topic: "all" })).toBe(await text({}));
  });

  it("returns only the requested section for a specific topic", async () => {
    const out = await text({ topic: "troubleshooting" });
    expect(out).toContain("## Troubleshooting");
    expect(out).toContain("jupyter-collaboration");
    // Other sections are excluded, and the full-guide header is dropped.
    expect(out).not.toContain("## Orientation");
    expect(out).not.toContain("# Working with notebooks via this MCP");
  });

  it("falls back to the full guide for an unknown topic", async () => {
    expect(await text({ topic: "bogus" })).toBe(await text({}));
  });

  it("documents the RTC requirement and the report_issue escape hatch", async () => {
    const out = await text({ topic: "troubleshooting" });
    expect(out).toContain("report_issue");
    expect(out).toMatch(/pip install jupyter-collaboration/);
  });

  it("explains persistent kernel state for iterative workflows", async () => {
    const out = await text({ topic: "execution" });
    expect(out).toMatch(/persist/i);
    expect(out).toContain("kernel_variables");
  });
});
