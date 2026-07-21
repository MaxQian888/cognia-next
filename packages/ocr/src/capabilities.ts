/**
 * Static capability metadata for every registered OCR provider.
 *
 * The settings UI reads from this map to render the per-provider Capabilities
 * tab, the side-by-side Compare view, and the inline micro-badges on the
 * sidebar rows. Provider modules themselves stay untouched — the rule is "one
 * place to edit when a provider's strengths change."
 *
 * `costTier` is intentionally coarse (free / $ / $$ / $$$). The user-facing
 * pre-flight cost estimate in Try It / Compare is a guidance ballpark, not a
 * billing contract — actual costs always come from the vendor.
 */

import type { OcrProviderCategory } from "./types"

export type OcrCostTier = "free" | "$" | "$$" | "$$$"
export type OcrCapabilityValue = "yes" | "no" | "partial"

/** Per-page USD ballpark used by `estimateOcrCost`. Free engines map to 0. */
const COST_TIER_PER_PAGE_USD: Record<OcrCostTier, number> = {
  free: 0,
  $: 0.005,
  $$: 0.015,
  $$$: 0.05,
}

/**
 * Capability flags surfaced in the UI. Every field is required so the matrix
 * stays consistent — `partial` is the escape hatch for "works but with
 * caveats" (e.g. Tesseract's handwriting story).
 */
export interface OcrCapabilityFields {
  /** Cursive / printed handwriting recognition quality. */
  handwriting: OcrCapabilityValue
  /** Detects and emits table structure (rows / columns / cells). */
  tables: OcrCapabilityValue
  /** Mathematical formulas / LaTeX output. */
  math: OcrCapabilityValue
  /** Chinese / Japanese / Korean script support. */
  cjk: OcrCapabilityValue
  /** Preserves block-level layout (paragraphs, columns, reading order). */
  layout: OcrCapabilityValue
  /** Runs without a network call. */
  offline: OcrCapabilityValue
  /** Number of supported languages (rough vendor-published count). */
  multilang: number
  /** Coarse pricing band; drives the `estimateOcrCost` ballpark. */
  costTier: OcrCostTier
  /** Maximum pages accepted per provider call. `null` = effectively unlimited. */
  maxPagesPerCall: number | null
  /** Returns structured blocks / JSON in addition to text / Markdown. */
  structuredOutput: OcrCapabilityValue
  /** Accepts multi-page PDFs natively (vs. requiring page-by-page rasterization). */
  pdfNative: OcrCapabilityValue
  /** Mirrors the registry category — convenient for grouping in the UI. */
  category: OcrProviderCategory
}

/**
 * Provider id → capability row. Every id present in `OCR_PROVIDER_REGISTRY`
 * (`components/settings/ocr/ocr-section.tsx`) must have an entry here; the
 * unit test enforces parity.
 */
export const OCR_PROVIDER_CAPABILITIES: Record<string, OcrCapabilityFields> = {
  "mistral-ocr": {
    handwriting: "partial",
    tables: "yes",
    math: "partial",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 80,
    costTier: "$",
    maxPagesPerCall: 1000,
    structuredOutput: "no",
    pdfNative: "yes",
    category: "document-cloud",
  },
  "google-vision": {
    handwriting: "yes",
    tables: "yes",
    math: "no",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 60,
    costTier: "$$",
    // images:annotate takes one image per call; PDFs are rasterized upstream
    // by pdf-router (files:annotate is not implemented).
    maxPagesPerCall: 1,
    structuredOutput: "yes",
    pdfNative: "no",
    category: "document-cloud",
  },
  "aws-textract": {
    handwriting: "partial",
    tables: "yes",
    math: "no",
    cjk: "partial",
    layout: "yes",
    offline: "no",
    multilang: 10,
    costTier: "$$$",
    // Sync DetectDocumentText/AnalyzeDocument: one image per call; the
    // provider rejects PDFs (pdf-router rasterizes pages upstream).
    maxPagesPerCall: 1,
    structuredOutput: "yes",
    pdfNative: "no",
    category: "document-cloud",
  },
  "azure-document-intelligence": {
    handwriting: "yes",
    tables: "yes",
    math: "no",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 150,
    costTier: "$$$",
    maxPagesPerCall: 2000,
    structuredOutput: "yes",
    pdfNative: "yes",
    category: "document-cloud",
  },
  "anthropic-vision": {
    handwriting: "yes",
    tables: "partial",
    math: "yes",
    cjk: "yes",
    layout: "partial",
    offline: "no",
    multilang: 100,
    costTier: "$$$",
    maxPagesPerCall: 20,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "llm-vision",
  },
  "openai-vision": {
    handwriting: "yes",
    tables: "partial",
    math: "yes",
    cjk: "yes",
    layout: "partial",
    offline: "no",
    multilang: 100,
    costTier: "$$$",
    maxPagesPerCall: 20,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "llm-vision",
  },
  "gemini-vision": {
    handwriting: "yes",
    tables: "partial",
    math: "yes",
    cjk: "yes",
    layout: "partial",
    offline: "no",
    multilang: 100,
    costTier: "$$",
    maxPagesPerCall: 30,
    structuredOutput: "partial",
    pdfNative: "partial",
    category: "llm-vision",
  },
  mathpix: {
    handwriting: "yes",
    tables: "yes",
    math: "yes",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 40,
    costTier: "$$",
    maxPagesPerCall: 1000,
    structuredOutput: "yes",
    pdfNative: "yes",
    category: "specialist",
  },
  "ocr-space": {
    handwriting: "no",
    tables: "partial",
    math: "no",
    cjk: "partial",
    layout: "no",
    offline: "no",
    multilang: 30,
    costTier: "free",
    maxPagesPerCall: 3,
    structuredOutput: "partial",
    pdfNative: "partial",
    category: "specialist",
  },
  "abbyy-cloud": {
    handwriting: "yes",
    tables: "yes",
    math: "partial",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 200,
    costTier: "$$$",
    maxPagesPerCall: 1000,
    structuredOutput: "yes",
    pdfNative: "yes",
    category: "specialist",
  },
  nanonets: {
    handwriting: "yes",
    tables: "yes",
    math: "no",
    cjk: "yes",
    layout: "yes",
    offline: "no",
    multilang: 30,
    costTier: "$$",
    // Sync LabelFile endpoint is documented for up to 3 pages per call.
    maxPagesPerCall: 3,
    structuredOutput: "yes",
    pdfNative: "yes",
    category: "specialist",
  },
  "lark-basic": {
    handwriting: "partial",
    tables: "yes",
    math: "no",
    cjk: "yes",
    layout: "partial",
    offline: "no",
    multilang: 20,
    costTier: "$$",
    maxPagesPerCall: 50,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "lark",
  },
  "tesseract-wasm": {
    handwriting: "partial",
    tables: "no",
    math: "no",
    cjk: "yes",
    layout: "no",
    offline: "yes",
    multilang: 100,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "local",
  },
  "tesseract-native": {
    handwriting: "partial",
    tables: "no",
    math: "no",
    cjk: "yes",
    layout: "no",
    offline: "yes",
    multilang: 100,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "local",
  },
  "windows-media-ocr": {
    handwriting: "partial",
    tables: "no",
    math: "no",
    cjk: "yes",
    layout: "partial",
    offline: "yes",
    multilang: 25,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "local",
  },
  "apple-vision": {
    handwriting: "yes",
    tables: "partial",
    math: "no",
    cjk: "yes",
    layout: "yes",
    offline: "yes",
    multilang: 25,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "yes",
    pdfNative: "no",
    category: "local",
  },
  "mlkit-android": {
    handwriting: "partial",
    tables: "no",
    math: "no",
    cjk: "yes",
    layout: "partial",
    offline: "yes",
    multilang: 50,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "partial",
    pdfNative: "no",
    category: "local",
  },
  ocrs: {
    handwriting: "partial",
    tables: "no",
    math: "no",
    cjk: "partial",
    layout: "yes",
    offline: "yes",
    multilang: 12,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "yes",
    pdfNative: "no",
    category: "local",
  },
  "paddle-ocr": {
    handwriting: "yes",
    tables: "partial",
    math: "no",
    cjk: "yes",
    layout: "yes",
    offline: "yes",
    multilang: 10,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "yes",
    pdfNative: "no",
    category: "local",
  },
  "local-http": {
    handwriting: "partial",
    tables: "partial",
    math: "no",
    cjk: "partial",
    layout: "partial",
    offline: "yes",
    multilang: 100,
    costTier: "free",
    maxPagesPerCall: null,
    structuredOutput: "partial",
    pdfNative: "partial",
    category: "local",
  },
}

/** All ids present in the capability map. Useful for tests and dropdowns. */
export const CAPABILITY_PROVIDER_IDS: readonly string[] = Object.keys(OCR_PROVIDER_CAPABILITIES)

/**
 * Best-effort USD cost estimate for a single OCR run.
 *
 * `pages` is the number of pages the user is about to submit (rasterized
 * images count as 1 page each). The result is rounded to 4 decimals so it
 * displays cleanly in the confirm dialog.
 */
export function estimateOcrCost(providerId: string, pages: number): number {
  const caps = OCR_PROVIDER_CAPABILITIES[providerId]
  if (!caps) return 0
  const pagesSafe = Math.max(1, Math.floor(pages))
  const perPage = COST_TIER_PER_PAGE_USD[caps.costTier]
  const total = pagesSafe * perPage
  return Math.round(total * 10000) / 10000
}

/** Top capability badges for the sidebar row (up to 3 most distinguishing). */
export function topSidebarCapabilities(providerId: string): readonly (keyof OcrCapabilityFields)[] {
  const caps = OCR_PROVIDER_CAPABILITIES[providerId]
  if (!caps) return []
  const candidates: (keyof OcrCapabilityFields)[] = []
  if (caps.handwriting === "yes") candidates.push("handwriting")
  if (caps.tables === "yes") candidates.push("tables")
  if (caps.math === "yes") candidates.push("math")
  if (caps.offline === "yes") candidates.push("offline")
  if (caps.cjk === "yes" && !candidates.includes("cjk")) candidates.push("cjk")
  if (caps.structuredOutput === "yes" && !candidates.includes("structuredOutput")) {
    candidates.push("structuredOutput")
  }
  return candidates.slice(0, 3)
}
