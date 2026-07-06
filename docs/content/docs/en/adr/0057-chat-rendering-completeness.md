---
title: ADR-0057 — Chat rendering completeness (MCP content blocks + subagent persistence)
description: "Two hard-to-reverse decisions taken while closing chat-rendering gaps: (1) preserve third-party MCP tool-result content[] blocks (text/image/resource/audio) onto the tool part instead of flattening them to an opaque string, so arbitrary MCP tools render images/resources richly rather than as a base64 wall; and (2) persist a completed subagent's terminal snapshot (toolCalls/logs/finalResponse) onto its message part so the inline dispatch tree survives a cold reload — without adding a Dexie table. Both are additive and backward-compatible with messages persisted before the change."
---

# ADR-0057 — Chat rendering completeness (MCP content blocks + subagent persistence)

**Status**: Proposed (2026-06-28)
**Authors**: Max Qian + Claude
**Builds on**: ADR-0020 (computer-use inline screenshots — the only prior image-survival precedent), ADR-0022 (agent-team runtime hardening), ADR-0024 (OCR subsystem), ADR-0032 (agent-team plugin integration).

## Context

The chat message renderer (`components/chat/message-renderer.tsx`) was already mature — ~20 part types, ~18 tools with dedicated rich cards, a depth-N subagent tree. Closing the remaining gaps surfaced two decisions whose cost-to-reverse is high enough to record, because both change the **shape of a persisted message part** and the **adapter pipeline** that produces it.

### Gap 3 — third-party MCP tool results

MCP tool results are, per spec, `content: [{type:'text'|'image'|'resource'|'audio', …}]`. The sidecar/SDK delivers that array intact, but `lib/claude/adapter.ts:flattenToolResultContent` collapsed it to a single string at `updateToolPart` before any renderer saw it: text blocks concatenated, every non-text block `JSON.stringify`-ed. An image block survived only as a base64 wall inside a JSON code block. Only cognia's own tools (`wiki_*`, `rag_search`, …) and Claude built-ins had dedicated cards; **every third-party MCP tool fell through to that opaque dump**. The structured array was alive at exactly one upstream point (`updateToolPart`), so the data needed to render richly already existed — it was being thrown away one step before the UI.

### Gap 7 — subagent inline tree vanishing on reload

The `subagent` message part carried only identity + a status snapshot; the live tool list, logs, and final response lived in the **ephemeral** `useSubagentRuntimeStore` (never persisted). Messages (with their `parts`) round-trip through the Dexie `messages` table verbatim. So after a page reload a completed run's expanded tree emptied out — the static fields survived, the run's actual work did not.

## Decision

### D1 — Preserve MCP `content[]` additively, render block-by-block

`lib/claude/adapter.ts` now attaches the original content blocks to the success-state tool part as `mcpContent?: McpResultBlock[]` (type in `lib/claude/parts-extensions.ts`) **while keeping** the flattened `output` string. A new `McpContentBlocksCard` (`components/chat/message-parts/mcp-renderers/`) walks the blocks: text → markdown, image → `ImageBlock`, resource → code/file/download, audio → `AudioBlock`. `McpToolBodyOrContent` routes any tool with no dedicated card to the blocks card when `mcpContent` is present, else to the generic `ToolBody`.

Two guards make this safe and low-noise:
- **Only attached when at least one block is non-text** (`extractMcpContentBlocks`). Pure-text results stay on the existing flattened-string path — no behavior change, no persistence bloat for the common case.
- **`output` is retained**, so messages persisted before this change (string-only) and the A2UI / error-state paths (which take precedence) are unaffected.

**Alternatives rejected.** (a) A heuristic JSON beautifier that `JSON.parse`-detects structure in the opaque string — lossy, guess-y, and pointless when the real array is available upstream. (b) Leaving the flatten in place — keeps third-party MCP image/resource output unusable.

### D2 — Persist the subagent terminal snapshot on the part (no new Dexie table)

`SubagentPart` gains optional `toolCalls` / `logs` / `finalResponse` / `toolUses`. `lib/claude/subagent-bridge.ts:applySubagentUpdate` writes them **only on a terminal status transition** (completed/failed/cancelled/timeout/rejected). `subagent-part.tsx` reads the live store first and falls back to the persisted snapshot when the run is gone (post-reload).

The terminal-only write is the load-bearing constraint: `subagentSignature` (the cheap change digest that gates message-array rewrites) deliberately excludes `toolCalls`/`logs`/`progress`, and already changes on the terminal transition. Writing the snapshot once, on that transition, piggybacks on a rewrite that was going to happen anyway — writing it on every running tick would rewrite the whole message array on each tool event (the exact churn the signature exists to avoid).

**Alternative rejected.** A new Dexie table mirroring the runtime store — it duplicates a persistence channel (`messages.parts`) that already round-trips verbatim, and would have to be re-joined to messages on load. The runtime store is correctly ephemeral; the persisted part is the right home for the frozen tree.

## Consequences

- **Backward-compatible.** Both changes are additive optional fields; `isSubagentPart` is unchanged (checks only `type`+`subagentId`); old persisted messages render exactly as before.
- **Bounded snapshot.** The persisted subagent snapshot inherits the store's caps (~100 toolCalls / ~50 logs); a run with more keeps only the most recent.
- **Pipeline coupling.** `adapter.ts` is now the single place that decides what survives to the renderer for generic tools — future rich-rendering work keys off `mcpContent`, not re-parsing strings.
- **Related gap-closing in the same change** (not ADR-worthy, recorded for context): unknown-part fallback card, non-image file preview, word-level diff (`fast-diff`), subagent streaming text gated to detailed mode, progress-UX unification onto an honest tool-count, a shared `BackgroundedRunControls`, the OCR `ocr-result` chat part, and mounting the artifact dock on the mobile chat shell.
