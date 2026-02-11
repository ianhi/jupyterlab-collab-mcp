import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://ianhi.github.io",
  base: "/jupyterlab-collab-mcp",
  integrations: [
    starlight({
      title: "JupyterLab Collab MCP",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ianhi/jupyterlab-collab-mcp",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/ianhi/jupyterlab-collab-mcp/edit/main/docs/",
      },
      sidebar: [
        { label: "jlab-mcp Launcher", slug: "jlab-mcp" },
        {
          label: "Tools",
          items: [
            { label: "Overview", slug: "tools" },
            { label: "Connection", slug: "tools/connection" },
            { label: "Reading", slug: "tools/reading" },
            { label: "Editing", slug: "tools/editing" },
            { label: "Execution", slug: "tools/execution" },
            { label: "Collaboration", slug: "tools/collaboration" },
            { label: "Metadata & Tags", slug: "tools/metadata" },
            { label: "Kernel & Analysis", slug: "tools/kernel" },
          ],
        },
        {
          label: "For Agents",
          items: [
            { label: "Best Practices", slug: "agents/best-practices" },
            { label: "Multi-Agent Workflows", slug: "agents/multi-agent" },
          ],
        },
        { label: "For Agents, by Agents", slug: "dogfooding" },
        { label: "Comparison", slug: "comparison" },
        { label: "Changelog", slug: "changelog" },
      ],
    }),
  ],
});
