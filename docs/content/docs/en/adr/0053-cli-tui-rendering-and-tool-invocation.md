---
title: ADR-0053 — Agent CLI TUI rendering & tool-invocation polish (streaming markdown cache · paced reveal · richer tool cards · sidecar tool performance)
description: "Make the cognia-agent TUI render markdown more naturally and stream more smoothly (content/theme-keyed render cache, word-snapped paced reveal, six heading levels, no heavy inline-code background, table link footnotes + width clamp, code-gutter hanging), enrich tool-invocation cards (per-tool spinner + elapsed, inline diff preview on permission approval, tool-aware result counts, completed-context-tool folding in the live transcript, hardened result correlation), and cut built-in tool latency in the sidecar (shared process snapshot cache, git repo-validation cache, non-blocking ripgrep probe, write decode dedup)."
---

# ADR-0053 — Agent CLI TUI rendering & tool-invocation polish

**Status**: Accepted (2026-06-20)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the [Agent CLI TUI](../subsystems/cognia-agent-tui) subsystem, ADR-0050 (operation-experience hardening), and the sidecar built-in tools.

## Context

The TUI's markdown renderer, tool-call cards, and the sidecar's built-in tools were all functional but had rough edges surfaced by a research pass (and by studying OpenCode / Crush / glamour):

- **Markdown** re-tokenized the whole reply and re-ran `cli-highlight` over every completed code block on **every** token flush (O(n²) over a long stream; highlight.js is the dominant cost). Inline code carried a heavy gray background by default; h4–h6 all collapsed to the h3 style; a table link rendered an inline `(url)` that the column-width math didn't count (misaligning the column); wide tables could overflow; wrapped code lines reset to column 0.
- **Tool cards** showed only a static `⏳` (no spinner or elapsed time), a raw line count regardless of tool, and no preview of an edit on the **permission** prompt. A `tool-result` missing its input could be mis-attached to the wrong card when several differently-named tools ran concurrently. Bursts of context-gathering tools (read/grep/glob/ls) buried the actual work.
- **Sidecar built-in tools** each re-enumerated all processes per call (4 read-only process tools, each spawning `ps`/PowerShell); every git tool spawned a second `git rev-parse` to validate the repo; the first ripgrep probe used `spawnSync`, blocking the event loop; `write` decoded its content twice.

## Decision

### Markdown rendering (`cli/src/tui/markdown/`, `components/Markdown.tsx`)

- **Render cache** (`render-cache.ts`): bounded LRU memoization of tokenization (by source) and code highlighting (by content + a theme key). A cache hit returns exactly what a direct call would, so output is identical — only the work is saved. This is the "(hash, theme)" caching that makes a completed code block O(1) per flush. We deliberately did **not** attempt token-level stable-prefix splicing: `marked` consumes a trailing blank line after some block types (heading/quote/hr/table) but emits a `space` token after others (paragraph/code/list), so splicing the stable prefix back together can't stay byte-identical without coupling to marked internals — and a mismatch would reflow the text when it commits.
- **Paced reveal** (`render/use-paced-reveal.ts`): an opt-out (`streamReveal` render pref), TTY-only, word/punctuation-snapped reveal of the live answer, mirroring OpenCode's `createPacedValue`. Inert in CI / non-interactive output.
- **Aesthetics**: six visually-distinct heading levels; inline code is a foreground colour with no default background (a theme may opt into `inlineCodeBg`); table columns are CJK-aware and width-clamped, with off-label links rendered as `label[n]` + a footnote list when OSC-8 is unavailable (which also fixes the link cell-width bug); code body lines hang under the gutter on wrap.

### Tool invocation (`components/CellView.tsx`, `DiffView.tsx`, `format/*`, `state/reducer.ts`)

- **Live status**: a running tool shows an animated spinner + `· Ns` elapsed (`render/use-elapsed-seconds.ts`).
- **Tool-aware result hints**: `format/tools.ts:resultCountLabel` gives grep "N matches", glob "N files", ls "N entries" instead of a raw line count.
- **Diff preview on approval**: the permission prompt previews the proposed edit inline (capped) via a shared `DiffView` reused by the tool card.
- **Context-tool folding** (`format/context-group.ts`): in the fullscreen **live** transcript, an adjacent run of completed context tools folds into one summary row. The classic `<Static>` scrollback keeps per-tool rows by design — it is append-only, so folding a growing run would corrupt already-written rows (a real constraint, surfaced rather than worked around).
- **Result correlation**: a nameless/keyless `tool-result` now completes the **sole** running tool only, never guessing among several concurrent tools of different names.

### Sidecar built-in tools (`sidecar/builtin-tools/`)

- **Process snapshot cache** (`process/inventory.mjs:getProcessSnapshot`): a short (1.5s) TTL snapshot shared by list/get/search/top_memory, collapsing a burst into one enumeration.
- **Git repo-validation cache** (`git/run.mjs`): a successful `assertRepo(cwd)` is memoized (failures are not, so a fresh `git init` is retried).
- **Non-blocking ripgrep probe** (`core/rg.mjs`): the first PATH lookup uses async `spawn` instead of `spawnSync`.
- **`write` decode dedup**: the incoming content is normalized once instead of twice.

## Consequences

- A long streamed reply no longer re-highlights completed code on every flush; transcript re-renders are cheaper.
- The user approves edits against a concrete diff; running tools show progress; search results read meaningfully.
- A process-heavy or git-heavy turn spawns far fewer subprocesses.

## Out of scope (deliberately deferred)

- **Token-level stable-prefix streaming** — fragile against marked's blank-line handling (above); the render cache delivers the streaming win safely instead.
- **Windowed `read`** — the file must already be read in full for binary detection, and `decodeText`'s whole-file BOM/EOL normalization is correctness-critical; a windowed rewrite risks output changes for a marginal allocation saving.
- **Unifying `content_search` / `file_search` onto the ripgrep engine** — a larger, behavior-sensitive change left for a focused follow-up.
- **Per-cell interactive expand/collapse in the `<Static>` scrollback** — incompatible with Ink's append-only model (the same constraint that bounds context folding to the live transcript).

## 2026-08 follow-up — renderer model and structured parts

Rendering now has a pure `TerminalBlock` layer containing styled terminal lines,
plain-copy text, exact row count, stable id, and interaction target. It continues
to use `marked@4`; the renderer work deliberately does not bundle a parser major
upgrade. Golden tests cover narrow widths, CJK/emoji/combining text, hostile
terminal controls, malformed streaming Markdown, tables/lists/quotes, and
Mermaid/math/A2UI fence fallbacks.

The canonical envelope gained additive `content-part` events for sources, files,
A2UI, artifact/canvas references, and custom fallbacks. Binary/base64 bodies are
excluded from durable events. URI and local-path policy gates hyperlinks and
media; only trusted builders may emit OSC-8, graphics, or screen controls.
