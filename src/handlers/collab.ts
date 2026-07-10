import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import { homedir } from "os";
import { join } from "path";
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import {
  getCellId,
  resolveCellId,
  generateUnifiedDiff,
  formatTimeRemaining,
  extractSource,
  getCellType,
} from "../helpers.js";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  type NotebookCell,
} from "../notebook-fs.js";
import {
  isJupyterConnected,
  listNotebookSessions,
  connectToNotebook,
  getConfig,
  apiFetch,
  saveNotebook,
  lspStatus,
  rtcAvailable,
} from "../connection.js";
import { getNotebookCells } from "../tool-helpers.js";
import {
  recordChange,
  getCellHistory,
  getChangesSince,
  getDeletedCellSource,
} from "../cell-tracker.js";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots as listSnapshotsForPath,
  restoreSnapshotToYjs,
  restoreSnapshotToFs,
  diffSnapshot,
} from "../snapshots.js";
import {
  acquireLocks,
  releaseLocks,
  listLocks as listLocksForPath,
} from "../cell-locks.js";

const REPORTS_PATH = join(homedir(), ".jupyter-mcp-reports.jsonl");
const REPORTS_MAX_BYTES = 1024 * 1024; // 1MB — rotate when exceeded
const SESSION_ID = crypto.randomUUID();

const VALID_CATEGORIES = ["tool_bug", "hang", "missing_feature", "observation", "user_feedback"] as const;
type ReportCategory = typeof VALID_CATEGORIES[number];

/** GitHub repo that issues about this MCP server belong to. */
const ISSUE_REPO = "ianhi/jupyterlab-collab-mcp";

/**
 * Build a ready-to-adapt GitHub issue from a report. Returns a structure (title
 * + sectioned body) for the human or agent to fill in and refine — it does not
 * prescribe whether or how the issue gets filed. Sections the report didn't
 * supply are left as explicit prompts rather than omitted, so nothing important
 * is silently dropped.
 */
export function buildIssueDraft(r: {
  category: string;
  summary: string;
  tool_name?: string;
  path?: string;
  details?: string;
}): string {
  const fill = "_(fill in)_";
  const isBug = r.category === "tool_bug" || r.category === "hang";

  const lines: string[] = [
    `This project (${ISSUE_REPO}) accepts fully agent-drafted issues — an issue whose entire content was written by an AI agent is welcome here.`,
    "",
    "Below is a structured draft to adapt:",
    "",
    "---",
    `**Title:** [${r.category}] ${r.summary}`,
    "",
    "## Summary",
    r.summary,
    "",
  ];

  if (isBug) {
    lines.push(
      "## Steps to reproduce",
      r.details ? r.details : `1. ${fill}`,
      "",
      "## Expected behavior",
      fill,
      "",
      "## Actual behavior",
      r.details ? "See details above." : fill,
      ""
    );
  } else {
    lines.push("## Details", r.details ? r.details : fill, "");
  }

  lines.push(
    "## Context",
    `- Tool: ${r.tool_name ?? "n/a"}`,
    `- Notebook path: ${r.path ?? "n/a"}`,
    `- jupyterlab-collab-mcp version: ${fill}`,
    `- JupyterLab / kernel: ${fill}`,
    "---"
  );

  return lines.join("\n");
}

/**
 * Rotate the reports file if it exceeds REPORTS_MAX_BYTES.
 * Keeps the most recent half of the file (by bytes) to avoid
 * reading/parsing the entire file. Finds the next newline after
 * the midpoint to avoid splitting a JSON line.
 */
function rotateReportsIfNeeded(): void {
  try {
    if (!existsSync(REPORTS_PATH)) return;
    const stat = statSync(REPORTS_PATH);
    if (stat.size <= REPORTS_MAX_BYTES) return;

    const content = readFileSync(REPORTS_PATH, "utf-8");
    // Keep the second half (most recent reports)
    const midpoint = Math.floor(content.length / 2);
    const nextNewline = content.indexOf("\n", midpoint);
    if (nextNewline === -1) return; // single giant line, leave it
    const trimmed = content.slice(nextNewline + 1);
    writeFileSync(REPORTS_PATH, trimmed);
  } catch {
    // Non-critical — don't block report submission
  }
}


export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "get_cell_history": async (args) => {
    const { path, cell_id, limit = 20 } = args as {
      path: string;
      cell_id: string;
      limit?: number;
    };

    const { doc } = await getNotebookCells(path);
    const history = getCellHistory(path, cell_id, limit, doc);
    if (history.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No change history found for cell '${cell_id}' in ${path}. History is only tracked during this session.`,
        }],
      };
    }

    const lines = history.map((c) => {
      const time = new Date(c.timestamp).toLocaleTimeString();
      let desc = `[v${c.version} ${time}] **${c.operation}** cell ${c.cellIndex} (${c.cellIdShort})`;
      if (c.client) desc += ` by ${c.client}`;
      if (c.detail) desc += ` — ${c.detail}`;
      if (c.operation === "update" && c.oldSource !== undefined) {
        const oldLines = c.oldSource.split("\n").length;
        const newLines = (c.newSource || "").split("\n").length;
        desc += ` (${oldLines} → ${newLines} lines)`;
      }
      return desc;
    });

    return {
      content: [{
        type: "text",
        text: `Change history for cell '${cell_id}' in ${path} (${history.length} entries):\n\n${lines.join("\n")}`,
      }],
    };
  },

  "get_notebook_changes": async (args) => {
    const { path, since_version = 0, limit = 50 } = args as {
      path: string;
      since_version?: number;
      limit?: number;
    };

    const { doc } = await getNotebookCells(path);
    const { changes, currentVersion } = getChangesSince(path, since_version, limit, doc);

    if (changes.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No changes since version ${since_version} in ${path}. Current version: ${currentVersion}`,
        }],
      };
    }

    const lines = changes.map((c) => {
      const time = new Date(c.timestamp).toLocaleTimeString();
      let desc = `v${c.version} [${time}] ${c.operation} cell ${c.cellIndex} (${c.cellIdShort})`;
      if (c.client) desc += ` by ${c.client}`;
      if (c.detail) desc += ` — ${c.detail}`;
      return desc;
    });

    return {
      content: [{
        type: "text",
        text: `Changes in ${path} since v${since_version} (${changes.length} changes, now at v${currentVersion}):\n\n${lines.join("\n")}`,
      }],
    };
  },

  "recover_cell": async (args) => {
    const { path, cell_id, index: insertAt, client_name } = args as {
      path: string;
      cell_id: string;
      index?: number;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    const { doc: notebookDoc } = await getNotebookCells(path);
    const deleted = getDeletedCellSource(path, cell_id, notebookDoc);
    if (!deleted) {
      return {
        content: [{
          type: "text",
          text: `No deleted cell matching '${cell_id}' found in change history for ${path}. History is only tracked during this session.`,
        }],
        isError: true,
      };
    }

    // Re-insert the recovered cell using the same logic as insert_cell
    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const cells = notebook.cells;

      const newCell: NotebookCell = {
        cell_type: "code",
        source: deleted.source,
        metadata: {},
        id: crypto.randomUUID(),
        outputs: [],
        execution_count: null,
      };

      const idx = insertAt ?? cells.length;
      cells.splice(idx, 0, newCell);
      await writeNotebook(resolved, notebook);

      const newId = (newCell.id || "").slice(0, 8);
      recordChange(path, {
        operation: "restore",
        cellId: newCell.id || "",
        cellIdShort: newId,
        cellIndex: idx,
        newSource: deleted.source,
        detail: `recovered from deleted cell ${cell_id}`,
        client: clientId,
      });

      return {
        content: [{
          type: "text",
          text: `Recovered deleted cell '${cell_id}' (deleted at ${deleted.deletedAt}) → inserted as cell ${idx} (id: ${newId}) in ${path}\n\nRecovered ${deleted.source.split("\n").length} lines of source.`,
        }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);
    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const newCell = new Y.Map();
    newCell.set("cell_type", "code");
    newCell.set("source", new Y.Text(deleted.source));
    newCell.set("metadata", new Y.Map());
    newCell.set("outputs", new Y.Array());
    newCell.set("execution_count", null);
    const newCellId = crypto.randomUUID();
    newCell.set("id", newCellId);

    const idx = insertAt ?? cells.length;
    cells.insert(idx, [newCell]);

    const newId = newCellId.slice(0, 8);
    recordChange(path, {
      operation: "restore",
      cellId: newCellId,
      cellIdShort: newId,
      cellIndex: idx,
      newSource: deleted.source,
      detail: `recovered from deleted cell ${cell_id}`,
      client: clientId,
    }, doc);

    return {
      content: [{
        type: "text",
        text: `Recovered deleted cell '${cell_id}' (deleted at ${deleted.deletedAt}) → inserted as cell ${idx} (id: ${newId}) in ${path}\n\nRecovered ${deleted.source.split("\n").length} lines of source.`,
      }],
    };
  },

  "snapshot": async (args) => {
    const { path, action, name: snapName, description: snapDesc } = args as {
      path: string;
      action: string;
      name?: string;
      description?: string;
    };

    if (action === "save") {
      if (!snapName) throw new Error("'name' is required for save action.");
      const { cells, doc } = await getNotebookCells(path);
      const snapshot = createSnapshot(path, snapName, cells, snapDesc, doc);

      return {
        content: [{
          type: "text",
          text: `Snapshot '${snapName}' saved for ${path} (${snapshot.cells.length} cells captured at ${snapshot.createdAt})${snapDesc ? `\nDescription: ${snapDesc}` : ""}`,
        }],
      };
    }

    if (action === "restore") {
      if (!snapName) throw new Error("'name' is required for restore action.");
      const { cells, mode, notebook, doc } = await getNotebookCells(path);

      const snapshot = getSnapshot(path, snapName, doc);
      if (!snapshot) {
        throw new Error(`No snapshot named '${snapName}' found for ${path}. Use snapshot with action='list' to see available snapshots.`);
      }

      // Auto-save a pre-restore snapshot for safety
      createSnapshot(path, `pre-restore-${Date.now()}`, cells, `Auto-saved before restoring '${snapName}'`, doc);

      if (mode === "jupyter" && doc) {
        const yCells = doc.getArray("cells");
        const restored = restoreSnapshotToYjs(snapshot, yCells, doc);

        recordChange(path, {
          operation: "restore",
          cellId: "",
          cellIdShort: "",
          cellIndex: -1,
          detail: `restored snapshot '${snapName}' (${restored} cells)`,
          client: "claude-code",
        }, doc);

        return {
          content: [{
            type: "text",
            text: `Restored snapshot '${snapName}' to ${path} (${restored} cells). A pre-restore snapshot was auto-saved.`,
          }],
        };
      } else if (notebook) {
        const newCells = restoreSnapshotToFs(snapshot);
        notebook.cells = newCells;
        const resolved = resolveNotebookPath(path);
        await writeNotebook(resolved, notebook);

        return {
          content: [{
            type: "text",
            text: `Restored snapshot '${snapName}' to ${path} (${newCells.length} cells). A pre-restore snapshot was auto-saved.`,
          }],
        };
      }

      throw new Error("Could not restore snapshot — notebook access failed.");
    }

    if (action === "list") {
      const { doc } = await getNotebookCells(path);
      const snaps = listSnapshotsForPath(path, doc);
      if (snaps.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No snapshots saved for ${path}. Use snapshot with action='save' to create one.`,
          }],
        };
      }

      const lines = snaps.map((s) => {
        const time = new Date(s.createdAt).toLocaleTimeString();
        let line = `- **${s.name}** (${s.cells.length} cells, ${time})`;
        if (s.description) line += ` — ${s.description}`;
        return line;
      });

      return {
        content: [{
          type: "text",
          text: `Snapshots for ${path} (${snaps.length}):\n\n${lines.join("\n")}`,
        }],
      };
    }

    if (action === "diff") {
      if (!snapName) throw new Error("'name' is required for diff action.");
      const { cells, doc } = await getNotebookCells(path);

      const snapshot = getSnapshot(path, snapName, doc);
      if (!snapshot) {
        throw new Error(`No snapshot named '${snapName}' found for ${path}.`);
      }

      const result = diffSnapshot(snapshot, cells);

      const summary = `Diff: snapshot '${snapName}' vs current ${path}:\n` +
        `  Added: ${result.added}, Deleted: ${result.deleted}, Modified: ${result.modified}, Unchanged: ${result.unchanged}`;

      const detailLines: string[] = [];
      for (const d of result.details) {
        if (d.status === "unchanged") continue;
        const prefix = d.status === "added" ? "+" : d.status === "deleted" ? "-" : "~";
        let line = `  ${prefix} ${d.cellId} (${d.status})`;

        if (d.status === "modified" && d.oldSource !== undefined && d.newSource !== undefined) {
          const oldLines = d.oldSource.split("\n").length;
          const newLines = d.newSource.split("\n").length;
          line += ` [${oldLines} → ${newLines} lines]`;
          // Show compact diff preview (first change)
          const diff = generateUnifiedDiff(d.oldSource, d.newSource, d.cellId);
          const diffLines = diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).slice(0, 6);
          if (diffLines.length > 0) {
            line += "\n" + diffLines.map(l => `      ${l}`).join("\n");
          }
        } else if (d.status === "deleted" && d.oldSource) {
          line += ` [${d.oldSource.split("\n").length} lines removed]`;
        } else if (d.status === "added" && d.newSource) {
          line += ` [${d.newSource.split("\n").length} lines added]`;
        }

        detailLines.push(line);
      }

      const details = detailLines.join("\n");
      return {
        content: [{
          type: "text",
          text: summary + (details ? `\n\n${details}` : "\n\n(no differences)"),
        }],
      };
    }

    throw new Error(`Unknown snapshot action '${action}'. Must be one of: save, restore, list, diff.`);
  },

  "cell_locks": async (args) => {
    const { path, action, cell_ids: lockCellIds, owner = "claude-code", ttl_minutes = 10, force = false } = args as {
      path: string;
      action: string;
      cell_ids?: string[];
      owner?: string;
      ttl_minutes?: number;
      force?: boolean;
    };

    if (action === "acquire") {
      if (!lockCellIds || lockCellIds.length === 0) {
        throw new Error("'cell_ids' is required for acquire action.");
      }

      // Resolve cell_id prefixes to full IDs
      const { cells, doc } = await getNotebookCells(path);
      const fullIds: string[] = [];
      for (const prefix of lockCellIds) {
        const idx = resolveCellId(cells, prefix);
        const cell = cells instanceof Array ? cells[idx] : (cells as any).get(idx);
        const fullId = getCellId(cell);
        if (fullId) fullIds.push(fullId);
      }

      const ttlMs = ttl_minutes * 60 * 1000;
      const result = acquireLocks(path, fullIds, owner, ttlMs, doc);

      const lines: string[] = [];
      if (result.acquired.length > 0) {
        lines.push(`Locked ${result.acquired.length} cell(s) for "${owner}" (expires in ${ttl_minutes} min):`);
        for (const lock of result.acquired) {
          const remaining = Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000);
          lines.push(`  ${lock.cellId.slice(0, 8)} — expires in ${formatTimeRemaining(remaining)}`);
        }
      }
      if (result.blocked.length > 0) {
        lines.push(`\nBlocked ${result.blocked.length} cell(s) — already locked:`);
        for (const b of result.blocked) {
          lines.push(`  ${b.cellId.slice(0, 8)} — held by "${b.owner}"`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "No cells to lock." }],
      };
    }

    if (action === "release") {
      if (!lockCellIds || lockCellIds.length === 0) {
        throw new Error("'cell_ids' is required for release action.");
      }

      // Resolve cell_id prefixes to full IDs
      const { cells, doc } = await getNotebookCells(path);
      const fullIds: string[] = [];
      for (const prefix of lockCellIds) {
        try {
          const idx = resolveCellId(cells, prefix);
          const cell = cells instanceof Array ? cells[idx] : (cells as any).get(idx);
          const fullId = getCellId(cell);
          if (fullId) fullIds.push(fullId);
        } catch {
          // Cell may have been deleted — try the prefix as-is
          fullIds.push(prefix);
        }
      }

      const result = releaseLocks(path, fullIds, owner, force, doc);

      const lines: string[] = [];
      if (result.released.length > 0) {
        lines.push(`Unlocked ${result.released.length} cell(s):`);
        for (const id of result.released) lines.push(`  ${id.slice(0, 8)}`);
      }
      if (result.notOwned.length > 0) {
        lines.push(`\n${result.notOwned.length} cell(s) owned by someone else (use force=true):`);
        for (const id of result.notOwned) lines.push(`  ${id.slice(0, 8)}`);
      }
      if (result.notFound.length > 0) {
        lines.push(`\n${result.notFound.length} cell(s) had no lock:`);
        for (const id of result.notFound) lines.push(`  ${id.slice(0, 8)}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "No cells to unlock." }],
      };
    }

    if (action === "list") {
      const { doc } = await getNotebookCells(path);
      const activeLocks = listLocksForPath(path, doc);

      if (activeLocks.length === 0) {
        return {
          content: [{ type: "text", text: `No active locks on ${path}.` }],
        };
      }

      const lines = [`${activeLocks.length} active lock(s) on ${path}:\n`];
      for (const lock of activeLocks) {
        const remaining = Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000);
        lines.push(`  ${lock.cellId.slice(0, 8)} — owner: "${lock.owner}", expires in ${remaining}s`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    throw new Error(`Unknown cell_locks action '${action}'. Must be one of: acquire, release, list.`);
  },

  "report_issue": async (args) => {
    // Coerce all inputs to strings defensively — agents may pass unexpected types
    const toString = (v: unknown, maxLen: number): string | undefined => {
      if (v == null) return undefined;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s;
    };

    const category = toString(args.category, 50);
    const summary = toString(args.summary, 500);
    const tool_name = toString(args.tool_name, 100);
    const path = toString(args.path, 300);
    // Details can be longer (tracebacks, etc.) but cap to keep writes atomic (<4KB)
    const details = toString(args.details, 2000);

    if (!category || !summary) {
      return {
        content: [{ type: "text", text: "report_issue requires 'category' and 'summary'" }],
        isError: true,
      };
    }

    if (!VALID_CATEGORIES.includes(category as ReportCategory)) {
      return {
        content: [{ type: "text", text: `Invalid category '${category}'. Must be one of: ${VALID_CATEGORIES.join(", ")}` }],
        isError: true,
      };
    }

    const report: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      session_id: SESSION_ID,
      category,
      summary,
    };
    if (tool_name) report.tool_name = tool_name;
    if (path) report.path = path;
    if (details) report.details = details;

    // Best-effort local log; never let a write failure block the draft below.
    let logged = true;
    try {
      appendFileSync(REPORTS_PATH, JSON.stringify(report) + "\n");
      rotateReportsIfNeeded();
    } catch {
      logged = false;
    }

    const draft = buildIssueDraft({ category, summary, tool_name, path, details });
    const logLine = logged
      ? `Logged locally to ${REPORTS_PATH}.`
      : `(Could not write the local log; the draft below is unaffected.)`;

    return {
      content: [{ type: "text", text: `${logLine}\n\n${draft}` }],
    };
  },

  troubleshoot: async (args) => {
    const { path } = args as { path?: string };
    const lines: string[] = [];

    // --- Connection health ---
    lines.push("## Connection");
    if (!isJupyterConnected()) {
      lines.push(
        "✗ Not connected to JupyterLab. Run connect_jupyter with your lab URL+token first.",
        "",
        "In this state, notebook edits go to the local .ipynb on disk (filesystem mode) — there is no collaboration room."
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const cfg = getConfig();
    lines.push(`✓ Connected: ${cfg.baseUrl}`);
    lines.push(
      rtcAvailable === true
        ? "✓ jupyter-collaboration (RTC): available — cell-level tools work."
        : rtcAvailable === false
          ? "✗ jupyter-collaboration (RTC): NOT installed — cell-level tools cannot open notebooks."
          : "? jupyter-collaboration (RTC): unknown (probe inconclusive)."
    );
    lines.push(
      lspStatus.available
        ? `✓ LSP: ${[...lspStatus.servers.keys()].join(", ") || "available"}`
        : "· LSP: not available (optional)."
    );

    if (!path) {
      lines.push(
        "",
        "Pass a notebook `path` to diagnose whether its edits actually sync and persist."
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // --- Per-notebook diagnosis ---
    lines.push("", `## Notebook: ${path}`);
    const flags: string[] = [];

    // Disk existence + mtime
    let diskExists = false;
    try {
      const res = await apiFetch(`/api/contents/${encodeURIComponent(path)}?content=0`);
      diskExists = res.ok;
      if (res.ok) {
        const meta = await res.json();
        lines.push(`✓ File on disk: exists (last_modified ${meta.last_modified}).`);
      } else {
        lines.push(`✗ File on disk: not found on this server (HTTP ${res.status}).`);
        flags.push("File is not served by the connected server — you may be pointed at the wrong server for this notebook.");
      }
    } catch (e: any) {
      lines.push(`? File on disk: check failed (${e.message}).`);
    }

    // Session / kernel
    try {
      const sessions = await listNotebookSessions();
      const session = sessions.find((s) => s.path === path);
      lines.push(
        session?.kernelId
          ? `✓ Kernel: active (${session.kernelId.slice(0, 8)}).`
          : "· Kernel: none (open_notebook to start one; not required for editing)."
      );
    } catch (e: any) {
      lines.push(`? Kernel: session lookup failed (${e.message}).`);
    }

    // Live room sync + peers + round-trip persistence check
    let docSig: string | null = null;
    try {
      const { doc, provider } = await connectToNotebook(path);
      const synced = provider?.synced === true && provider?.wsconnected !== false;
      lines.push(
        synced
          ? "✓ Sync: connected and synced to the server room."
          : "✗ Sync: NOT synced (socket disconnected) — edits sit in the local buffer and may not reach the server."
      );
      if (!synced) flags.push("Provider not synced: an edit right now is not confirmed on the server.");

      const awareness = provider?.awareness;
      let peers = 0;
      if (awareness) {
        for (const id of awareness.getStates().keys()) if (id !== awareness.clientID) peers++;
      }
      lines.push(
        peers > 0
          ? `✓ Peers: ${peers} other client(s) in the room (e.g. your browser tab).`
          : "· Peers: none besides this MCP — disk autosave may not run without a peer, and you can't see edits live."
      );
      if (peers === 0) flags.push("No browser peer: open the notebook in JupyterLab on THIS server to collaborate live.");

      const cells = doc.getArray("cells");
      docSig = contentSignature([...cells]);
      lines.push(`· Room content: ${cells.length} cells.`);
    } catch (e: any) {
      lines.push(`✗ Sync: could not connect to the room (${e.message}).`);
      flags.push("Could not open the collaboration room — edits would not sync.");
    }

    // Forced save + disk-vs-room round trip (the split-brain detector)
    if (diskExists && docSig !== null) {
      try {
        const { status } = await saveNotebook(path);
        lines.push(
          status === "success"
            ? "✓ Forced save: server reported success."
            : status === "skipped"
              ? "· Forced save: skipped (already up to date / save in progress)."
              : `✗ Forced save: FAILED (status=${status}) — edits are NOT reaching disk.`
        );
        if (status === "failed") flags.push("save_notebook failed: edits are not persisting to disk.");

        // Re-read disk and compare sources+types with the room.
        const res = await apiFetch(`/api/contents/${encodeURIComponent(path)}?content=1`);
        if (res.ok) {
          const nb = await res.json();
          const diskCells = nb?.content?.cells ?? [];
          const diskSig = contentSignature(diskCells);
          if (diskSig === docSig) {
            lines.push("✓ Round-trip: disk matches the room — edits persist to THIS file. Healthy.");
          } else {
            lines.push(
              "🛑 Round-trip: disk does NOT match the room even after a forced save."
            );
            flags.push(
              "SPLIT-BRAIN: the room you are editing is not the one saved to this file. " +
                "Almost always a second/overlapping jupyter server. Ensure ONE server per directory " +
                "and that Claude + the browser use the SAME server URL."
            );
          }
        }
      } catch (e: any) {
        lines.push(`? Forced save / round-trip: ${e.message}`);
      }
    }

    // --- Verdict ---
    lines.push("", "## Verdict");
    if (flags.length === 0) {
      lines.push("✓ Healthy — edits sync to the room and persist to this file.");
    } else {
      lines.push("⚠ Issues detected:");
      for (const f of flags) lines.push(`  • ${f}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};

/** Order-sensitive signature of a notebook's cells (type + source only), for
 * comparing a live room against the on-disk copy. Ignores outputs/metadata so
 * execution state doesn't create false mismatches. */
function contentSignature(cells: any[]): string {
  return JSON.stringify(
    cells.map((c) => [getCellType(c), extractSource(c)])
  );
}
