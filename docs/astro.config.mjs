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
        { label: "jupyter-claude Launcher", slug: "jupyter-claude" },
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
          label: "Guides",
          items: [
            { label: "Multi-Agent Collaboration", slug: "guides/multi-agent" },
          ],
        },
        { label: "Comparison", slug: "comparison" },
        { label: "Changelog", slug: "changelog" },
      ],
    }),
  ],
});
