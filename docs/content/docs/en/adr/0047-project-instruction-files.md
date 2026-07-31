---
title: ADR-0047 — Project Instruction Files
description: "On-disk instruction loading for the built-in agent: AGENTS.md / AGENT.md / CLAUDE.md discovered across the active workspace with a configurable nesting walk (layered up-tree, Claude Code, or nearest-wins, opencode), a global user file, a .cognia/instructions/ dir, recursive @import expansion, and wiring of the dormant markdown-agents parser to .cognia/agents/*.md project subagents."
---

# ADR-0047 — Project Instruction Files

**Status**: Accepted (2026-06-09)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0030 (character/persona prompt stack) and the `resolveSendOptions` assembly in `lib/claude/build-options.ts`; reuses the pure-resolver + Tauri-reader split established by ADR-0044/0046 (`lib/lsp/resolve-config.ts` + `project-file-reader.ts`)
**Affects**: `lib/claude/instructions/*` (new module), `lib/claude/build-options.ts`, `lib/claude/types.ts` (`AppSettings.instructions`, `Character.instructionsOverride`), `lib/claude/agents/markdown-agents.ts` (now wired), `components/settings/instructions/instructions-card.tsx` (new), `components/settings/general-section.tsx`, `i18n/messages/{en,zh-CN}.json`

## Context

The built-in agent assembled its system prompt entirely from in-app sources — character prompt, persona, skills, mode, twin, memory — and was **blind to on-disk instruction files**. The `CLAUDE.md` / `AGENTS.md` convention that Claude Code and opencode use to give a project (and each subdirectory) standing instructions was ignored: opening a real workspace with a root `CLAUDE.md` had no effect on the agent.

A parse + merge layer for markdown-defined subagents (`lib/claude/agents/markdown-agents.ts`) already existed but was **dormant** — its own docstring noted "filesystem discovery is injected … the Tauri/global-dir wiring lives at the call site," and that wiring was never built. So `.cognia/agents/*.md` project subagents never loaded either.

## Decision

A new `lib/claude/instructions/` module, structured as a **pure, fs-injected core** (fully unit-testable) behind a **thin Tauri adapter** — the same split as the LSP resolver, so the discovery/merge logic never imports the filesystem directly and the real I/O reuses `lib/file/file-operations.ts` (`exists`/`readDir`/`readText`, already web/mobile-safe → empty/false off-Tauri).

### Discovery (`discover.ts`)

Produces the ordered, de-duplicated list of files, lowest-precedence first so a nearer-cwd block overrides an earlier one by recency:

1. **Global** user file — explicit `globalPath`, else the first existing `~/.cognia/{AGENTS,AGENT,CLAUDE}.md`.
2. **Ancestor files** — `mode: "layered"` (Claude Code) collects every instruction file from the workspace root down to cwd; `mode: "nearest"` (opencode) stops at the first ancestor dir that has one. Same-dir precedence is `AGENTS.md > AGENT.md > CLAUDE.md` (configurable). The walk is bounded by the owning workspace root, falling back to a depth-capped climb so a stray cwd can never trigger a whole-disk scan.
3. **`.cognia/instructions/*.md`** under each root.
4. **`extraPaths`** — opencode-style `instructions[]`: relative paths plus a simple trailing `*.md` glob (no globbing dependency).

Dedupe is a `Set` keyed by a case-normalized absolute path (Windows-aware), the canonical opencode/Claude-Code guard. Path math lives in `paths.ts` — dependency-free helpers whose separator follows the *input string* (a `C:\proj` cwd vs a `/home/x` cwd), avoiding Node's `path` (stubbed in the static-export/mobile bundle).

### Imports (`imports.ts`)

`@path` references are expanded recursively (Claude Code parity, which opencode lacks): resolved relative to the file's dir, inlined with their own imports first, guarded by a `seen` set (cycles) and `maxDepth`. `@` tokens inside fenced code blocks are ignored, and a token whose file doesn't read is left untouched — so `user@host`-style text never triggers a probe.

### Render + load (`render.ts`, `load.ts`)

Files render as labelled `## <relpath>` blocks joined by `\n\n---\n\n`, with `maxFiles` / `maxFileBytes` caps that **warn** rather than silently truncate. `load.ts` orchestrates discover → read → expand → render → agent-discovery behind a per-`(cwd+config)` memo cache (3 s TTL, `clearInstructionCache()`), because `resolveSendOptions` runs every turn and must not re-walk the tree per send. Off-Tauri or disabled → empty.

### Project subagents (`discover-agents.ts`)

Walks `.cognia/agents/*.md` across roots plus a global agents dir into the `MarkdownAgentFile[]` the existing `buildMarkdownAgents` consumes — global first, the **primary root last**, so a project's `.cognia/agents/foo.md` wins on id collision.

### Wiring (`build-options.ts`)

The `cwd` resolution is hoisted above the system-prompt assembly; the discovered `instructionSection` joins the **stable prompt prefix** (after base/persona, before memory) so provider prompt caches keep hitting. It is skipped for `--bare` (no on-disk auto-discovery, Claude Code parity) and is naturally dropped for `workflow-editor` sessions, which overwrite the whole prompt. Discovered subagents merge into `opts.agents` **after** the registry/template subagents so the project wins. Config resolves `Character.instructionsOverride ?? AppSettings.instructions ?? defaults`, surfaced by a new bilingual "Project Instructions" settings card.

## Consequences

- A workspace's `CLAUDE.md` / `AGENTS.md` — including nested per-directory files and `@import`-ed fragments — now reaches the agent, matching the Claude Code / opencode mental model users already have.
- Projects can ship custom subagents as `.cognia/agents/*.md`, activating a parser that had been built-but-inert.
- Everything is best-effort and inert on web/mobile (no project filesystem); a load failure never blocks a send.
- Trade-offs accepted this round: local paths/globs only (no remote-URL `extraPaths` like opencode); no per-message "nearby AGENTS.md on file-read" injection (the directory walk covers the nesting need); GEMINI.md / `.cursorrules` filenames are out of scope. Real desktop-shell (Tauri) smoke verification of home-dir + arbitrary-root reads is still outstanding.
