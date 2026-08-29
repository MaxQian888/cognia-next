---
title: ADR-0062 — External-agent session-history graph import
description: "Loss-aware import of eleven local coding-agent history formats with lineage, lifecycle, background work, mirror reconciliation, plugin compatibility, and capability-gated native resume."
---

# ADR-0062 — External-agent session-history graph import

**Status**: Accepted (2026-07-04)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0048 (Codex support), ADR-0051 (external-agent-adapter plugin type — the overlay pattern mirrored here), ADR-0009/0037 canonical `ChatSession` / `StoredMessage` model, the chat-export importer (`lib/data/import-registry.ts`).

## Context

Cognia could *run* external agents (Codex `app-server`, OpenCode, ACP) and *reuse* their credentials/memory, but it could **not read their on-disk session histories**. A read-only sweep confirmed the gap concretely:

- `lib/claude/replay.ts` re-serializes **Dexie** messages, not `~/.claude/projects/*.jsonl`.
- The chat-export importer parses **web-export JSON** (chatgpt / claude.ai / gemini) over a **closed** `ChatImportFormat` union — no CLI JSONL, and its plugin overlay (`registerChatImporter`) is not reachable from `ctx`.
- The Codex `app-server` adapter **declares `session/list|fork|resume` unsupported** — a live driver cannot enumerate past threads.

The goal was an extensible mechanism — easy to add OpenCode and future agents, and contributable **via plugins** — that turns a past on-disk session into a normal, **continuable** Cognia conversation.

### Disk-format research

- **Claude Code**: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one record/line (`type` user/assistant/summary/system, nested Anthropic `message.content[]` blocks: text / thinking / tool_use / tool_result / image, plus top-level `toolUseResult`). Encoded-cwd = path with `/`,`.`,`\` → `-` (reuses `encodeClaudeProject`).
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (honors `$CODEX_HOME`), each line `{ timestamp, type, payload }`, `type` ∈ session_meta / response_item / event_msg / turn_context / compacted. `response_item` payloads: message (`input_text`/`output_text`), reasoning, function_call / function_call_output (+ custom_tool_call variants), `ghost_snapshot` (filtered).
- **OpenCode**: current builds persist to **SQLite** `~/.local/share/opencode/opencode.db` (session / message / part tables, polymorphic `data` JSON), plus a share-export JSON. Heavier than the pure-JSONL agents.

## Decision

Introduce a dedicated **session-source registry** (`lib/session-import/`), modeled on the clean `SubagentSourceAdapter` pattern rather than overloading the in-memory `ChatImporter`. A source implements the two-step reality of on-disk histories:

```ts
interface AgentSessionSourceAdapter {
  id; displayName; labelKey; acceptedExtensions
  scanRoots(home): string[]                              // desktop auto-scan roots
  detect(files): "match" | "maybe" | "no"                // picker auto-detect
  listSessions(input): Promise<SessionSummary[]>         // cheap: titles + counts
  parseSession(ref, input): Promise<ImportedConversation> // full parse on demand
}
```

- **Target reuse**: adapters emit `ImportedConversation { session: ChatSession; messages: StoredMessage[] }` — persisted by the existing `applyImported` (one Dexie txn over `sessions` + `messages`). Parts use only shapes the chat `MessageRenderer` already handles (text / reasoning / `tool-<name>` / file), cross-checked against `lib/ai/agent/external/event-to-parts.ts`. A stable id `import:<source>:<originalId>` makes re-scans upsert instead of duplicate. Each session gets a `branchSeed:{kind:"transcript"}` so it is **continuable**.
- **Registry + plugin overlay** (`registry.ts`): static `[claude-code, codex, opencode]` plus a runtime overlay (`registerSessionSource` / `unregisterSessionSourcesByPlugin`) owner-tracked by `pluginId`, namespaced `${pluginId}:${id}`, static-wins — the exact ADR-0051 shape.
- **FS**: `SessionFs` (superset of `ExternalFs`, adds `readTextFile`) over `lib/file/file-operations.ts`; recursive `walkFiles` for the date-nested Codex tree. Desktop-only scans; the file/folder picker fallback works on web.
- **OpenCode SQLite**: a read-only Rust command `opencode_sessions_read` (`src-tauri/src/session_import.rs`, `rusqlite`, schema-tolerant) returns normalized sessions; the TS adapter maps them (and also parses the share-export JSON in the picker path).
- **Plugin extension point**: `ctx.import.registerSessionSource(adapter)` (imperative twin, `lib/plugin/api/import-api.ts`) delegates to the overlay with the plugin's id and returns a disposer — a plugin can add an agent (OpenCode variant, Cursor, Cline, …) with no host change.
- **UI**: `SessionImportDialog` (Settings → Data → Domain-transfer) + `useSessionImport` state machine (idle → scanning → list → importing → done). Desktop auto-scans every source; web picks files. Imported sessions land in the main `ChannelList`.

## Consequences

- Claude Code, Codex, and OpenCode histories import as first-class, continuable conversations, rendered by the existing pipeline with no renderer changes.
- Adding a new agent is one static adapter (or one plugin calling `ctx.import.registerSessionSource`) — the registry, canonical target, persistence sink, FS, and UI are shared.
- Continuation flows through the standard `branchSeed` path and therefore the **PII redaction gate** on the first send.
- Incremental/watch re-import, the declarative `sessionImporters` manifest bridge, graph reconstruction, and eleven first-party sources have shipped. Source-private state with no public representation remains an explicit loss rather than a fabricated canonical field.
- ADR-0107 composes this session importer with settings, skills, subagents, MCP, commands, and memory behind one migration wizard; this registry remains the authoritative session implementation.

## Verification

Jest (`lib/session-import`, `hooks/session-import`, `components/session-import`, `lib/plugin/api/import-api`) green; Rust `cargo test --lib session_import` 3/3; typecheck / ESLint / `lint:i18n` parity clean; the six project auditors (test-gap, i18n, static-export, tauri-rust, pii-gate, wiring) clean — the wiring auditor confirms the registry, `ctx` API, dialog, and Rust command are reachable at runtime.

## 2026-08-29 amendment — canonical graphs and native recovery

`CanonicalSession` remains version 1 and gains optional source provenance, runtime binding, lineage,
lifecycle, richer turns/tools/usage, tasks, plans/goals, checkpoints, history operations, and inter-agent
messages. Unknown upstream events are retained as bounded, redacted diagnostics and produce an exact
loss entry; adapters may ignore unknown fields but may not silently discard unknown event kinds.

Every built-in now implements `parseGraph`. The legacy `parseSession` plugin contract remains readable
and is wrapped as a flat, explicitly downgraded graph. Claude Code, Codex, OpenCode, Gemini CLI,
Continue, Aider, Pi, Cursor, Cline, Copilot CLI, and Qwen Code are the registry-derived source set.

Re-import uses a digest over message contents, parts, tool state, relationships, and lifecycle. A
`source-mirror` follows rewinds and removals, tombstones vanished children, and preserves local
decoration. Continuing in Cognia changes ownership to `cognia-owned`. Native resume requires an existing
matching preset, a connected executable runtime, live-verified `session/resume`, an existing cwd, and a
successful handshake; only then is the session marked `native-bound` and the verified native id reused
for execution. No presets, credentials, or commands are created automatically.

Cursor cloud/background history and every source without a stable public format (including Kiro, Droid,
and DeepSeek Harness) remain outside import scope. Their runtime presets remain visible separately in the
generated support matrix.
