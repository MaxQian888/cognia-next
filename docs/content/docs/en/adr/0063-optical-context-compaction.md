---
title: ADR-0063 — Optical context compaction (snapcompact "text-as-image")
description: "A new 'optical' conversation-compaction strategy that renders older turns into compact PNG frames a vision model reads back, instead of summarizing them to lossy text. Pure-TypeScript sidecar renderer ported from oh-my-pi's snapcompact.rs, with adaptive per-provider shape selection + token budgeting, a round-trip readability gate with automatic text-summary fallback, multi-frame pagination, and durable archival with an in-transcript viewer."
---

# ADR-0063 — Optical context compaction

**Status**: Accepted (2026-07-06)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the generic (AI-SDK) compaction pipeline (`sidecar/dispatch/compaction*.mjs`, `lib/claude/compact-instructions.ts`, ADR-notes on frozen-summary prefix stability), the `compact_boundary` event + undo-snapshot path (`lib/claude/adapter.ts`, `lib/claude/compaction-undo.ts`).
**Inspiration**: [`oh-my-pi` `crates/pi-natives/src/snapcompact.rs`](https://github.com/can1357/oh-my-pi/blob/main/crates/pi-natives/src/snapcompact.rs) (the `text → PNG` hot path) and the DeepSeek-OCR line of "optical context compression" research.

## Context

Every existing compaction strategy (`summary`, `hybrid`, `selective`, `recursive`, `sliding-window`) is **lossy text**: older turns are replaced by an LLM summary or dropped. Long agent runs therefore trade away verbatim detail — exact file paths, tool output, decisions — to stay under the window.

`snapcompact` is a different idea: **rasterize the archived text into a dense image** and let a vision-capable model read it back. A tiny pixel font packs thousands of characters into one small frame; because vision-token cost tracks image **resolution** (tiles), not text length, a full frame of packed text can cost far fewer tokens than the equivalent text — while keeping the **actual words** rather than a summary of them. This is "optical" / text-as-image compression.

We studied `snapcompact.rs` end to end. It is only the hot `text → PNG bytes` path; normalization, framing, provider-shape selection, and archive management were left to a (proprietary) TypeScript layer. Its shape controls — five bundled pixel/TrueType fonts, six-hue sentence-boundary ink cycling (`sent`) vs. plain black (`bw`, best for Anthropic readers), `lineRepeat` redundancy bands, Lanczos3 cell stretching, two-column "doc" layout, dim spans for tool output (`U+000E/F`), full-block newline folding (`U+2588`), and palette-narrowed 1/2/4-bit indexed PNG — are all eval-validated.

## Decision

Add an **`optical`** compaction strategy to the generic path, implemented as a **pure-TypeScript sidecar subsystem** (no native module — the sidecar has no napi, and a pure-TS renderer works identically across the browser / Tauri / Capacitor shells; inlined font data rides the existing `dispatch/*.mjs` ship path in both the esbuild-CLI and Tauri bundlers). The renderer is a faithful port of `snapcompact.rs`; on top of it we add the four capabilities the reference left out.

### Renderer (`sidecar/dispatch/optical/`)

- `fonts-data.mjs` / `fonts.mjs` — embedded public-domain bitmap fonts (`unscii-8` 8×8, X.org `misc-fixed` 5×8) with hex + BDF parsers.
- `raster.mjs` — grid + two-column "doc" rasterization, sentence-hue cycling, dim spans, full-block cell fill, line-repeat bands, wide-cell (CJK) geometry.
- `resample.mjs` — separable Lanczos3 for the stretch shapes.
- `png.mjs` — hand-rolled PNG via Node `zlib` (indexed 1/2/4-bit palette narrowing + truecolor RGB).
- `render.mjs` — `renderSnapcompactPng(text, options)` → base64 PNG (indexed for native cells, RGB for stretched).

### Extensions (the "more functionality")

1. **Adaptive shape + token budget** (`layout.mjs`) — maps the target model to a vision-pricing family (Anthropic / OpenAI / Google), picks the eval-optimal font/cell/variant (bw for Anthropic; the 6×6 stretch for OpenAI), estimates each frame's vision-token cost, and only proceeds when the optical archive is cheaper than the equivalent text. Paginates across multiple frames, closing/reopening dim spans across the cut.
2. **Round-trip readability + auto-fallback** (`readability.mjs`, `compact.mjs`) — a one-shot vision read-back transcribes the first frame; multiset word-recall below a threshold discards the archive and falls back to a text summary. Coverage, budget, overflow, and readability are four gates; any failure returns `null` and the orchestrator summarizes the same `middle` as text, so **context is never dropped to an unreadable image**.
3. **Original archival + on-demand view** (`lib/db/optical-archives.ts` Dexie v101, `lib/claude/optical-archive-persist.ts`, `components/chat/message-parts/optical-archive-dialog.tsx`) — each boundary persists the frames + token stats + the pre-compaction transcript; the compact-boundary marker gains a "View frames" button opening a dialog with the image(s), the before/after token comparison, and an on-demand reveal of the original text (durable across reloads, unlike the in-memory undo registry).
4. **Hybrid framing + multi-frame** — tool output is dim-shaded, newline runs fold to full-block, the transcript paginates into up to `maxFrames` images, and the recent tail stays verbatim text (the plan's `middle → image`, `tail → text` split is inherently hybrid).

### Pipeline integration

`planStrategy` gains an `optical` plan kind carrying the same `middle` shape as `single` (so fallback is trivial). `maybeCompact` renders + verifies, splices the archive as a `role:"user"` message whose leading text sentinel makes it a **frozen artifact** (`isSummaryMessage` / `isOpticalMessage` recognize array-content messages) — so prior optical archives are carried forward verbatim, never re-imaged or lost. The `compact_boundary` event carries the frames + stats in `compact_metadata.optical`.

## Capability boundary

v1 inlines only the two small Latin-1 pixel fonts. The larger X.org BDFs and the CJK TrueType (Silver) are a documented extension point: they are too heavy to inline, and **CJK-heavy transcripts route to the text-summary fallback** via the coverage gate + round-trip check rather than being mis-rendered as blanks. This is an honest capability boundary, not a stripped code path — the full rendering pipeline (all shape controls, hues, dim, block, repeat, doc, stretch, palette narrowing) is implemented. Adding a bundled CJK `.hex` (e.g. a GNU Unifont subset, same parser) would lift the boundary without touching the pipeline.

## Consequences

- Optical compaction is opt-in (`Settings → Conversation → Compaction method → Optical`); the default stays `hybrid`.
- The strategy costs one extra vision call per compaction when verification is on (default), bounded to the first frame.
- Vision-token savings are real only for large archives on cheap-per-pixel families; the budget gate declines small or expensive cases automatically.
- Storage: archives are capped at the newest 100 rows; frames are small (indexed PNG), original text can be larger but is bounded by the compacted `middle`.
