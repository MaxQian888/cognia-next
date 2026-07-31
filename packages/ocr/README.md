# @cognia/ocr

Framework-agnostic **OCR core** for Cognia — extracted from `lib/ocr/` (ADR-0024).

Holds the dependency-injected half of the OCR subsystem, with **zero `@/` app imports**. Every
environment-bound concern is supplied by the caller through `ExtractDeps`: the result/page caches,
the credentials resolver, the registry, settings, and platform tag.

## What's here

- `index.ts` — the public `extract()` pipeline (source resolve → cache → provider → escalate → cache)
- `registry.ts`, `auto-router.ts`, `capabilities.ts`, `provider-recommendations.ts` — provider selection
- `providers/` — the cloud + WASM adapters (Anthropic/OpenAI/Gemini vision, Azure, AWS Textract,
  Google Vision, Mathpix, Mistral, Nanonets, ABBYY, OCR.space, PaddleOCR, Lark, local HTTP,
  tesseract-wasm/native, ocrs, Windows Media OCR) and the shared `_http` / `_llm-vision` / `_sigv4` helpers
- `pdf-router.ts`, `pdf-stream.ts`, `pdf-loader.ts` — PDF page routing, resumable streaming, loading
- `cache-contract.ts` — the `OcrResultCache` / `OcrPageCache` injection seam (+ explicit null caches)
- `confidence.ts`, `document.ts`, `citation.ts`, `export-hocr.ts`, `image-prep.ts`, `blob-utils.ts`,
  `hash.ts`, `errors.ts`, `probe.ts`, `ocr-parameter-schemas.ts`
- `types/` — the OCR type contracts (folded from `types/ocr/`)

## Stays app-side (in `lib/ocr/`)

`cache.ts` (Dexie), `credentials.ts` (keyring + settings), `deps.ts` (the `buildOcrDeps` binding),
`runtime.ts` (native provider wiring), and `providers/{apple-vision,mlkit-android}.ts` (Capacitor
bridges). These construct the deps and hand them to this package.

## Resolution

Resolved **from source** in dev/test/build via root `tsconfig.json` paths + `jest.config.ts`
moduleNameMapper. `dist` is produced by `tsup` only to prove standalone compilation.
