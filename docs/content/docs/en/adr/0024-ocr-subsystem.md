---
title: ADR 0024 — OCR subsystem
description: Cross-shell text extraction from images and PDFs. Plumbs 20 OCR providers behind one `extract()` surface, with a platform-aware auto-router, a Dexie-backed result cache, and a PDF text-layer fast-path.
---

# ADR 0024 — OCR subsystem

> **Status**: Accepted on 2026-05-18. Revised 2026-08-08 to repair runtime
> capability reporting, routing, model delivery, and local transports. The
> local providers — `ocrs` (pure-Rust ONNX via RTen), `paddle-ocr`
> (PP-OCRv6 via `oar-ocr` + ONNX Runtime), and `local-http` (generic
> adapter for self-hosted servers like Umi-OCR / PaddleOCR-Server).

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
Linux without Tesseract).

## Decision

A new subsystem under `lib/ocr/` exposes a single `extract(input, deps)`
entry point. Every provider plugs into the same registry; every
caller — composer menu, `/ocr` slash command, `ocr.extract` plugin tool —
goes through the same dispatch path so the cache, auto-router, and
credential lookups stay in one place.

### Provider matrix (20)

| Category            | Providers                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Document OCR cloud  | `mistral-ocr`, `google-vision`, `aws-textract`, `azure-document-intelligence`                                              |
| LLM vision cloud    | `anthropic-vision`, `openai-vision`, `gemini-vision`                                                                       |
| Specialist cloud    | `mathpix`, `ocr-space`, `abbyy-cloud`, `nanonets`                                                                          |
| Feishu / Lark cloud | `lark-basic`                                                                                                               |
| On-device           | `tesseract-wasm`, `tesseract-native`, `windows-media-ocr`, `apple-vision`, `mlkit-android`, `ocrs`, `paddle-ocr`           |
| Self-hosted HTTP    | `local-http` — generic adapter, dialect-aware (Umi-OCR / PaddleOCR-Server). User-pinned, never auto-selected by the router |

The three LLM-vision providers (`anthropic-vision`, `openai-vision`,
`gemini-vision`) reuse the main provider keyring entries instead of asking
for a second credential. Every other cloud provider stores credentials
under the keyring namespace `"ocr"` keyed by provider id.

### Auto-router

`lib/ocr/auto-router.ts:pickDefaultProvider` consults three signals in order:

1. `UserOcrSettings.defaultProviderId` when it is a concrete id, enabled, and
   reported ready by the shared runtime-capability contract. An unavailable
   persisted default is normalized to `"auto"` with a visible reason.
2. The ready local candidate chain. macOS tries `apple-vision` then
   `paddle-ocr`; Windows and Linux try `paddle-ocr`; mobile uses the matching
   OS engine; browsers use `tesseract-wasm`. `ocrs` and
   `windows-media-ocr` remain stable advanced ids but are never auto-routed.
3. The configured cloud fallback (default `mistral-ocr`) when local engines
   are unavailable and credentials are configured.

Automatic extraction executes this ordered candidate chain, continuing after
retryable availability, rate-limit, network, and provider failures. Explicit
provider requests never switch providers. Abort, invalid input, and unsupported
language failures stop immediately. Cache identity uses the provider that
actually succeeds.

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

`crates/cognia-ocr` exposes the Tauri command surface:

- `ocr_extract_native(payload)` — dispatches by `payload.backend`
  (`tesseract` / `windows-media-ocr` / `apple-vision` / `ocrs` /
  `paddle-ocr`) to the registered `NativeBackend`.
- `ocr_msix_status()` — reports whether the running Windows process has an
  MSIX package identity. The frontend caches this at boot and uses it to
  gate `windows-media-ocr` in the auto-router.
- `ocr_model_status(backend, variant)` — reports version, selected variant,
  integrity, and per-file installation state for
  backends that download their own weights (`ocrs`, `paddle-ocr`). Returns
  `{ installed, files[], total_bytes, model_dir }`; the auto-router
  consults this to skip backends whose models aren't downloaded yet.
- `ocr_download_model(backend, variant, request_id)` — streams pinned model
  files into versioned directories, emitting `ocr://download-progress`
  events as bytes land. Writes a `manifest.json` with SHA-256s on
  completion. Downloads use temporary files plus atomic replacement, recover
  corrupt files, deduplicate concurrent requests per variant, and can be
  terminated by `ocr_cancel_model_download(request_id)`.
- `ocr_http_fetch` / `ocr_http_cancel` — packaged-desktop transport for
  `local-http`. Redirects and public/link-local/metadata targets are rejected;
  loopback is allowed, while private/LAN endpoints require exact-endpoint user
  confirmation.

The standard desktop build enables `ocr-paddle`; CI rejects a release whose
default feature no longer binds `cognia-ocr/ocr-paddle`. `ocr-ocrs` remains an
opt-in advanced feature. Apple Vision is target-gated and always compiled on
macOS:

- `ocr-tesseract` → the locally installed Tesseract CLI. Its `tempfile`
  dependency is available in the feature-gated runtime path.
- `ocr-windows` retains the stable `windows-media-ocr` id, but its real
  Windows.Media.Ocr binding is not implemented and is always reported
  unavailable.
- `apple-vision` (no feature; compiled whenever the target is macOS) →
  Vision.framework's `VNRecognizeTextRequest` in-process via the
  `objc2-vision` bindings — no sidecar, no model downloads.
- `ocr-ocrs` → `ocrs` + `rten` (pure-Rust, no system deps).
- `ocr-paddle` → `oar-ocr` 0.9.x + ONNX Runtime, with selectable PP-OCRv6
  Small (default) and Tiny variants.

When a feature is off the registry advertises a `PlaceholderBackend` that
returns `MissingBinding(id)`. The TS layer surfaces that as
`OcrError("unsupported_shell")` and the auto-router falls through to the
next candidate.

### Model distribution

`ocrs` and `paddle-ocr` add substantial weights to the
installer. Instead the bundle ships without weights and the settings UI
exposes a "Download models" button per backend. Files land in
`<app_data>/cognia/ocr/<backend>/`; Paddle variants use separate
`v6-small` / `v6-tiny` directories. Unversioned PP-OCRv5 files are preserved
and reported as legacy/non-active. License notes:

- `ocrs` detection + recognition models — Apache-2.0 (trained on HierText,
  CC-BY-SA 4.0 for the dataset; weights themselves are Apache-2.0).
- PP-OCRv6 models — Apache-2.0.

The download manifest pins every expected SHA-256. Readiness requires live
digest verification; file presence alone is never treated as an installed
model.

### Local HTTP dialects

`local-http` is configured from `OCR_PARAMETER_SCHEMAS`. A legacy plaintext
token is migrated into the OCR keyring and removed from settings. Umi-OCR
queries `/api/ocr/get_options` and maps BCP-47 hints to the exact advertised
`ocr.language` model value while preserving each response `end` separator.
The Paddle dialect sends the PaddleOCR 3.x `/ocr` request shape and accepts its
`result.ocrResults[].prunedResult` response, while retaining compatibility with
the older hubserving dict and tuple response shapes. Language hints are hints,
not evidence that every native backend consumes them. `ocrs` is a Latin-only
early preview; Tesseract WASM requires traineddata download unless `langPath`
points to local assets.

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
