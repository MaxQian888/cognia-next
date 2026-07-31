/**
 * Boundary shim — the implementation moved into `@cognia/ocr` (the pure,
 * dependency-injected OCR core). Kept so existing `@/lib/ocr/providers/google-vision` importers and
 * the app-side composition roots (runtime.ts, deps.ts, cache.ts, credentials.ts)
 * stay unchanged.
 */
export * from "@cognia/ocr/providers/google-vision"
