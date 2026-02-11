---
title: For Agents, by Agents
description: How agent-driven dogfooding shaped every feature in this MCP server.
---

The real users of an MCP server aren't humans — they're AI agents. So the best way to build one is to have agents use it and tell you what's broken.

This project was developed by having Claude agents do real notebook work (not synthetic tests) and write feedback reports after each round. Their reports directly drove the roadmap. Every collaboration feature — cell IDs, locking, change tracking, snapshots, per-agent attribution — exists because an agent ran into a problem and said "I need this."

## Round 1: Single agent, basic tools

One Claude agent built a notebook from scratch. It immediately revealed that positional indices are fragile — inserting a cell shifts every index below it. This led to **cell ID addressing**: stable 8-character IDs that survive insertions and deletions.

**Features added:** cell ID addressing, prefix matching, `cell_id` and `cell_ids` parameters on all tools.

## Round 2: Human + agent collaboration

Working alongside a human in the same notebook exposed a key problem: the agent would overwrite cells the human was actively editing. This led to **cursor awareness** (`get_user_focus`) and **human-focus protection** — write tools now check the JupyterLab awareness protocol and refuse to modify cells a human is typing in.

**Features added:** `get_user_focus`, human-focus protection with `force=true` override, awareness protocol integration.

## Round 3: Agent teams (Lorenz attractor)

Six Claude agents worked simultaneously across four notebooks to simulate and analyze a Lorenz attractor:
- An **ETL agent** loaded and preprocessed data
- A **model agent** computed Lyapunov exponents (getting 0.9069 — real math!)
- A **visualization agent** built plots
- An **adversary agent** deliberately tried to corrupt other agents' work

23 out of 23 adversary tests passed — lock enforcement held up. But the round exposed that `copy_cells` operations weren't being tracked in the change log, and that the default lock TTL (5 minutes) was too short for agents that think slowly.

**Features added:** `copy_cells`/`move_cells` change tracking, 10-minute default lock TTL, `batch_insert_cells`, `client_name` attribution parameter.

## Round 4: Concurrent writes to the same notebook

Five agents all wrote to the **same two notebooks simultaneously** — building a weather station dashboard. This was the stress test for the collaboration system.

Results:
- 31 cells, 39 tracked versions
- True same-second concurrent writes
- Zero cell ID collisions, zero data loss
- Lock enforcement: 4/4 adversary attempts blocked
- `recover_cell`: successful delete + recovery with full content preservation

**Features added:** `recover_cell` gained `client_name` for proper attribution, lock override audit trail.

## Agent-requested features

Every round, each agent wrote a feedback report. Here's what they asked for and what shipped:

| Agent request | Status |
|--------------|--------|
| Stable cell references (not indices) | Shipped (v0.2.0) — cell ID addressing |
| Don't overwrite cells I'm editing | Shipped (v0.2.0) — human-focus protection |
| Cell locking between agents | Shipped (v0.4.0) — advisory locks with TTL |
| Know what changed since I last looked | Shipped (v0.4.0) — `get_notebook_changes` polling |
| Recover deleted cells | Shipped (v0.4.0) — `recover_cell` from change history |
| Save/restore checkpoints | Shipped (v0.4.0) — named snapshots |
| Track who made each change | Shipped (v0.5.0) — `client_name` parameter |
| Audit trail for lock overrides | Shipped (v0.5.0) — force-overrides recorded in change tracking |
| Insert multiple cells at once | Shipped (v0.7.0) — `batch_insert_cells` |
| Longer lock TTL | Shipped (v0.7.0) — 10 minutes default |
| Cross-notebook change feed | Not yet implemented |
| Per-cell `try_lock` (non-blocking) | Not yet implemented |
| Kernel environment info | Not yet implemented |

The [multi-agent guide](../agents/multi-agent/) documents the collaboration patterns that emerged from this process.

For how to use these features, see [Best Practices](../agents/best-practices/) and [Multi-Agent Workflows](../agents/multi-agent/).
