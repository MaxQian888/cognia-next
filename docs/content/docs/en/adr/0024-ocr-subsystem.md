---
title: ADR 0024 — OCR subsystem
description: Cross-shell text extraction from images and PDFs. Plumbs 17 OCR providers behind one `extract()` surface, with a platform-aware auto-router, a Dexie-backed result cache, and a PDF text-layer fast-path.
---

# ADR 0024 — OCR subsystem

> **Status**: Accepted on 2026-05-18.

## Context

cognia-next ships in three shells — browser (static export), Tauri 2.9
desktop, and Capacitor 7 mobile — and the only way users currently get
text out of an image is to forward it to a multimodal model. That's
expensive, slow on PDFs, and forces the model to act as an OCR engine
even when the user just wants the words.

The system needs first-class OCR for both inline composer use ("extract
text from this attachment") and agent-driven use ("the model decides to
read a screenshot mid-conversation"). It also has to cover the platform
matrix without forcing users to pick a single provider — local engines
for offline scenarios, cloud providers when accuracy matters, and a
fallback chain when local engines aren't ready (Windows without MSIX,
macOS without the Apple Vision sidecar binary, Linux without Tesseract).

## Decision

A new subsystem under `lib/ocr/` exposes a single `extract(input, deps)`
entry point. Every provider plugs into the same registry; every
caller — composer menu, `/ocr` slash command, `ocr.extract` plugin tool —
goes through the same dispatch path so the cache, auto-router, and
credential lookups stay in one place.

### Provider matrix (17)

| Category            | Providers                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Document OCR cloud  | `mistral-ocr`, `google-vision`, `aws-textract`, `azure-document-intelligence`              |
| LLM vision cloud    | `anthropic-vision`, `openai-vision`, `gemini-vision`                                       |
| Specialist cloud    | `mathpix`, `ocr-space`, `abbyy-cloud`, `nanonets`                                          |
| Feishu / Lark cloud | `lark-basic`                                                                               |
| On-device           | `tesseract-wasm`, `tesseract-native`, `windows-media-ocr`, `apple-vision`, `mlkit-android` |

The three LLM-vision providers (`anthropic-vision`, `openai-vision`,
`gemini-vision`) reuse the main provider keyring entries instead of asking
for a second credential. Every other cloud provider stores credentials
under the keyring namespace `"ocr"` keyed by provider id.

### Auto-router

`lib/ocr/auto-router.ts:pickDefaultProvider` consults three signals in order:

1. `UserOcrSettings.defaultProviderId` when it's a concrete id (not `"auto"`)
   and the provider is registered, enabled, and shell-compatible.
2. The platform-local preference table — Windows + MSIX picks
   `windows-media-ocr`, macOS / iOS pick `apple-vision`, Android picks
   `mlkit-android`, browsers pick `tesseract-wasm`.
3. The configured cloud fallback (default `mistral-ocr`) when local engines
   are unavailable and credentials are configured.

The router is pure — it takes a registry, settings, platform tag, optional
readiness probe (`isReady`), and optional credentials probe
(`hasCredentials`). All three are stubbed in unit tests so the table is
fully covered without spinning up real backends.

### Output schema

Per-page Markdown + plain text + optional structured blocks with bounding
boxes and confidence. Cloud document providers (`google-vision`,
`aws-textract`, `azure-document-intelligence`) fill the `blocks` array;
LLM-vision providers (`anthropic-vision`, etc.) leave it empty. Mistral
OCR returns its native Markdown; the synthesized `text` field strips
Markdown decorations. `combinedMarkdown` joins pages with
`\n\n---\n\n<!-- page N -->` dividers so multi-page PDFs render with clear
boundaries.

### PDF strategy

`lib/ocr/pdf-router.ts:extractPdf` runs in two passes:

1. **Text-layer fast-path.** Each page in range gets `page.getTextContent()`
   via `pdfjs-dist`. Pages with ≥16 non-whitespace characters are accepted
   as-is — no OCR cost.
2. **OCR fallback.** Pages whose text layer is effectively empty are
   rasterized at 220 DPI (configurable) and routed through the OCR provider.

This keeps digital PDFs free and scanned PDFs accurate. The router is
also DI-friendly: tests pass a fake `loadPdf` returning canned pages so
the routing logic is fully covered without a real pdfjs worker.

### Cache

`lib/db/ocr-results.ts` adds a Dexie table `ocrResults` (schema v36) keyed by
`sha256(file) | providerId | sortedLangs.join(",")`. Same image + provider +
language combo never spends twice. Settings exposes a global "clear cache"
button and a per-provider variant. TTL purge is implemented via
`purgeOcrCacheOlderThan(ttlMs)` but not wired to a cron yet — the user can
clear manually.

### Triggers

| Surface           | Path                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer menu     | `components/chat/composer/ocr-menu.tsx` + hover dropdown on any image/PDF attachment — "Extract text to input" or "View extracted text".                               |
| Slash command     | `/ocr <file or attachment_id> [--provider auto\|<id>] [--lang en,zh] [--pages 1-3] [--format markdown\|text\|blocks]`. Handler in `lib/slash-commands/actions/ocr.ts`. |
| Plugin agent tool | `plugins/ocr/src/index.ts` registers `ocr.extract` — single tool, provider id is a parameter.                                                                          |

### Native bindings (Rust)

`src-tauri/src/ocr/mod.rs` exposes two Tauri commands:

- `ocr_extract_native(payload)` — dispatches by `payload.backend`
  (`tesseract` / `windows-media-ocr` / `apple-vision`) to the registered
  `NativeBackend`.
- `ocr_msix_status()` — reports whether the running Windows process has an
  MSIX package identity. The frontend caches this at boot and uses it to
  gate `windows-media-ocr` in the auto-router.

Real bindings ride three Cargo features:

- `ocr-tesseract` → `tesseract-rs` (cross-platform, statically linked
  libtesseract + leptonica).
- `ocr-windows` → `winocr` crate (Windows + MSIX).
- `ocr-apple` → Swift sidecar at `src-tauri/sidecars/apple-vision-ocr/`
  bundled via `tauri.conf.json` `bundle.externalBin`.

When a feature is off the registry advertises a `PlaceholderBackend` that
returns `MissingBinding(id)`. The TS layer surfaces that as
`OcrError("unsupported_shell")` and the auto-router falls through to the
next candidate.

### Testing strategy

Native backends are isolated behind the `NativeBackend` trait so CI runs
mock implementations. Real bindings live behind `#[cfg(target_os = …)]`
blocks excluded from coverage targets. TS-side `__set*Invoker` helpers let
unit tests inject canned invokers without an actual Tauri runtime.

### Files of record

- `lib/ocr/` — public surface, providers, auto-router, PDF router, cache.
- `lib/db/ocr-results.ts` — Dexie row + CRUD.
- `lib/slash-commands/actions/ocr.ts` — `/ocr` parser + dispatcher.
- `components/settings/ocr/` — dedicated settings section under
  `settings.tabs.ocr`.
- `components/chat/composer/ocr-menu.tsx`, `ocr-result-bubble.tsx`,
  `attachment-preview.tsx` — composer integration.
- `hooks/use-ocr.ts` — React hook wrapping `extract()` with state.
- `plugins/ocr/` — first-party plugin exposing `ocr.extract`.
- `src-tauri/src/ocr/` — native command surface + backend trait.

## Alternatives considered

- **Single mega-provider (e.g. Mistral OCR only).** Rejected — the project
  spans three shells with different connectivity assumptions; the user
  asked for full coverage.
- **Plugin per provider.** Rejected — every provider hits the same
  registry and cache, and the auto-router needs a stable enumeration.
  Putting providers into separate plugin packages would fragment the
  dispatch path.
- **No on-device engines.** Rejected — mobile and Linux desktops without
  reliable Internet still need OCR; bundling Tesseract WASM costs ~2 MB but
  gives every shell an offline floor.

## Consequences

- New top-level subsystem (`lib/ocr/`) plus one new Dexie table.
- Settings page mirrors the precedent set by `components/settings/search/`:
  a dedicated section for a non-LLM provider family with its own credential
  surface.
- Tauri picks up two new commands + one new state (`NativeOcrRegistry`).
  Three optional Cargo features control which native bindings get linked.
- Frontend bundle grows when tesseract.js + pdfjs-dist are pulled into the
  composer route. Both are already declared dependencies, but the OCR
  feature is the first to import tesseract.js — the worker assets need to
  be copied into `public/ocr/` by a build script (`scripts/copy-ocr-
assets.mjs`) before the WASM provider can run.
