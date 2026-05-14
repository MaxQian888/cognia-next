---
title: "0008 — External Bridge (LLM Wiki + MCP server)"
description: "Cognia exposes its own knowledge to external coding agents via an opt-in MCP server, backed by a generated code wiki."
---

# ADR 0008 — External Bridge (LLM Wiki + MCP server)

**Status:** Implemented (Phase 1 MVP — 2026-05-04)
**Implementer:** External-Bridge MVP, branch `feat/external-bridge-phase1`

## Context

cognia-next had three asymmetric integration surfaces with the
LLM-coding-agent ecosystem:

1. **Outbound** — full client coverage of ACP / OpenCode / Anthropic
   SDK so Cognia can drive Claude Code, Cursor, etc. as subagents.
2. **In-process plugins** — rich plugin system at `lib/plugin/` with
   tools/modes/hooks/marketplace.
3. **Inbound** — _nothing_. External agents had no way to consult
   Cognia's knowledge: not the Twin runtime data, not the installed
   skills/characters, and (because no wiki existed) not even the
   shape of Cognia's own source.

The asymmetry mattered because every LLM coding agent the user runs
_outside_ Cognia (their daily Claude Code session, an embedded Cursor
helper) is implicitly working blind to whatever Cognia has already
distilled for the user. Reversing the flow — giving those agents a
read-only window into Cognia — closes the loop without forcing them
to live inside the Cognia shell.

Industry convergence on the **Model Context Protocol** (MCP) made the
choice of wire format obvious. Reading two reference systems shaped
the design directly:

- **DeepWiki** (Cognition Labs) — eager generation of structured
  Markdown per repo + a small set of MCP tools (`read_wiki_structure`,
  `read_wiki_contents`, `ask_question`) — proved the "wiki content as
  the canonical retrieval substrate" pattern.
- **zilliztech/claude-context** — full lifecycle MCP surface
  (`index_codebase`, `search_code`, `clear_index`, `get_indexing_status`)
  showed the right shape for "user owns the pipeline" vs. DeepWiki's
  read-only.

We chose a hybrid: ship the **read** half eagerly (DeepWiki shape),
defer the inbound **write** half to Phase 4 (where it pairs with the
distill pipeline that consumes external-agent transcripts).

## Decision

Build a self-contained "External Bridge" subsystem that:

1. **Generates a wiki for Cognia's own source** at index time, stored
   in 4 new Dexie tables (v17). The orchestrator reuses the existing
   Twin ingest chunker (`lib/twin/ingest/chunk.ts:prepareChunks`) but
   does NOT reuse Twin's distill pipeline — wiki articles are not
   "drafts pending review", they're the durable artifact.
2. **Exposes the wiki + Cognia runtime entities via MCP** through a
   bridge under `lib/external-bridge/`. Tools and resources are
   gated by an OptIn whitelist; default install allows only
   `wiki:cognia` + `rag:cognia` (public-code only).
3. **Ships stdio transport in Phase 1**; HTTP transport lands when
   the Tauri Rust path (axum-based) is wired in Phase 1.5 / 2.
   We deliberately avoided Next.js `app/api/mcp` routes because
   `next.config.ts:output:"export"` (required for Tauri builds) drops
   server runtime — see R1 in the plan.
4. **Stores per-call audit log in `mcpAuditLog` (capped 5000 newest)**
   so the user can see what external agents have been asking.

### Architecture

```
                 ┌────────────────────────────────────┐
                 │      Cognia Tauri / Web App         │
                 ├────────────────────────────────────┤
External Agent   │  lib/external-bridge/mcp-server     │
(Claude Code,    │     server.ts ── McpServer SDK      │
 Cursor, …)      │     transport-stdio.ts              │
                 │     standalone-entry.ts (node CLI)  │
       ──MCP────►│                                     │
                 │  lib/external-bridge/handlers/      │
                 │     wiki / rag / runtime / resources│
                 │     ↓                               │
                 │  lib/external-bridge/permission-gate│
                 │     ↓                               │
                 │  lib/wiki/orchestrator.ts ──────────┤
                 │     RepoMap + ModuleArticle +       │
                 │     CrossRef + IndexPage agents     │
                 │     ↓                               │
                 │  Dexie:wikiArticles + wikiSections  │
                 │        wikiManifest + mcpAuditLog   │
                 └────────────────────────────────────┘
```

### MCP surface

Tools (Phase 1):

- `wiki_search(query, scope?, k?)` → top-K article summaries
- `wiki_read(slug)` → full Markdown + sourceRefs
- `rag_search(query, scope?, k?)` → section-level chunks (BM25-ish)
- `runtime_query(entityType, op, id?, filter?)` → list/get for
  skill / character / twin / plugin / agent-team

Resources (Phase 1):

- `cognia://wiki/<slug>`
- `cognia://skill/<id>` (rendered as SKILL.md)
- `cognia://character/<id>` (JSON)

Permission scopes (default OFF except first two):

- `wiki:cognia`, `rag:cognia` ← Phase 1 default ON
- `wiki:user-repo`, `rag:user-repo` ← Phase 3
- `runtime:skills`, `runtime:characters`, `runtime:twins`,
  `runtime:plugins`, `runtime:agent-teams` ← user opts in

### Wiki generation pipeline

```
file walker → merkle diff → twin chunker → repo-map agent
            → module-article agent (one LLM call per module)
            → cross-ref agent (insert [[slug]] links)
            → persist to wikiArticles + wikiSections
            → index-page agent → exporter (optional) → docs/.mdx
```

PageRank in `RepoMapAgent` is a size-based heuristic in Phase 1
(boost for `index.ts` / `page.tsx` / `mod.rs`); full personalized
PageRank with a tree-sitter import graph is deferred to Phase 2.

## Consequences

**Positive:**

- External Claude Code sessions can ask "how does Cognia's twin
  distill work?" and get grounded answers with file:line citations.
- Adds zero overhead to Cognia's own runtime — the bridge boots only
  when the user enables it in Settings.
- Default-deny + per-scope OptIn keeps user content private by
  default; nothing leaks unless the user explicitly toggles the scope
  for the entity family.
- Audit log makes "what did the external agent ask?" inspectable
  without digging through agent-side logs.
- Reuses the Twin ingest chunker + LlmClient so we didn't fork the
  embedding/LLM surface.

**Negative:**

- Adds a new dep (`@modelcontextprotocol/sdk`) that we now need to
  track for upgrade churn.
- Two non-trivial pieces deferred to later phases:
  - HTTP transport (Rust hyper/axum, M3 in the plan)
  - Inbound write tools + IDE log scanner + web crawl (Phases 4–6)
- Wiki content is LLM-generated → quality depends on prompt + model.
  CrossRefAgent's hard validation (`findDeadLinks` throws on broken
  links) catches structural bugs but not factual ones.

**Neutral:**

- 5 sub-component split for the Settings UI was collapsed into a
  single `external-bridge-section.tsx` (~250 LOC). Per-component
  refactor when the UI grows past a screen.

## Files added (Phase 1)

- `types/wiki/index.ts`
- `lib/db/{wiki-articles,wiki-sections,wiki-manifest,mcp-audit-log}.ts`
- `lib/db/schema.ts` (v17 stores added; no upgrade hook needed —
  the new tables are pure additions)
- `lib/external-bridge/{types,permission-gate,token,audit-log}.ts`
- `lib/external-bridge/handlers/{wiki,rag,runtime,resources}.ts`
- `lib/external-bridge/mcp-server/{server,transport-stdio,standalone-entry}.ts`
- `lib/wiki/{file-walker,merkle,types,prompts,orchestrator,exporter}.ts`
- `lib/wiki/agents/{repo-map-agent,module-article-agent,cross-ref-agent,index-page-agent}.ts`
- `components/settings/external-bridge/external-bridge-section.tsx`
- `components/settings/settings-nav-config.ts` (added `external-bridge`)
- `components/settings/settings-shell.tsx` (router case)
- `i18n/messages/{en,zh-CN}.json` (3 keys per locale)
- `CLAUDE.md` (External Bridge section)
- `lib/claude/types.ts` (added `AppSettings.externalBridge`)

Total: 41 source files + 21 co-located test files; 349 tests across
24 test suites all green.

## Deferred (Phase 2+)

- **Phase 1.5/M3**: Tauri Rust HTTP MCP server (`src-tauri/src/mcp_server/{http_server,sidecar,ipc_to_main,commands}.rs`).
  Adds the `axum` + `hyper` crates to `src-tauri/Cargo.toml`.
- **Phase 2**: `packages/claude-code-plugin/` — npm-distributed
  plugin shell with bundled MCP server binary + skills + slash
  commands + agents.
- **Phase 3**: User-repo wiki — same orchestrator pipeline,
  `scope: "user-repo"`, Settings UI for adding repos.
- **Phase 4**: Inbound write tools (`record_lesson`, `save_skill_draft`,
  `ingest_note`) + `inboundDrafts` table + `InboundDistiller`.
- **Phase 5**: Passive IDE log scanner (`~/.claude/projects/`,
  Cursor history, Cline logs).
- **Phase 6**: Web crawler (awesome-claude-code, Anthropic docs RSS,
  MCP server registries) on the existing `lib/scheduler/` cron.

## Open risks (carried forward)

- **R1** (resolved): HTTP MCP must NOT live under `app/api/mcp` —
  Tauri's static export precludes API routes. Decision is Rust hyper.
- **R2**: Dexie in Node standalone bundles. Phase 2 plugin packaging
  needs `fake-indexeddb` (already a devDep) at runtime, OR a
  `better-sqlite3`-backed Dexie adapter.
- **R3**: Full wiki rebuild cost. ~150K LOC × N modules at 8K input
  / 2K output tokens per call ≈ $5–15 per rebuild. Settings UI shows
  a confirm dialog; incremental refresh is the default.
- **R7**: Prompt-injection in wiki content. Mitigation: write tools
  default OFF; wiki content wrapped in `<untrusted_content>` tags
  when returned via MCP (Phase 4).

See `~/.claude/plans/llm-wiki-cognia-claudecode-agent-sleepy-moonbeam.md`
for the full plan + progress log.
