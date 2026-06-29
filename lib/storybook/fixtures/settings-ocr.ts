// Fixture builders for Settings → OCR stories. Each builder fills every
// required field with a realistic default so the object satisfies the
// `@/types/ocr` shapes and is valid as a component `arg`. Spread `over` to
// vary one field. Named `settings-ocr.ts` to avoid colliding with the
// `settings-provider.ts` fixtures owned by other story authors.
import {
  DEFAULT_OCR_SETTINGS,
  type OcrPage,
  type OcrResult,
  type UserOcrSettings,
} from "@/types/ocr"
import type { OcrSidebarProvider } from "@/components/settings/ocr/ocr-sidebar"
import type { OcrCompareProviderOption } from "@/components/settings/ocr/ocr-compare-view"

/** A single OCR page with both markdown and plain text populated. */
export function makeOcrPage(over: Partial<OcrPage> = {}): OcrPage {
  return {
    pageNumber: 1,
    markdown: "# Invoice\n\n| Item | Qty | Price |\n| --- | --- | --- |\n| Widget | 2 | $4.00 |",
    text: "Invoice\nItem Qty Price\nWidget 2 $4.00",
    ...over,
  }
}

/** A realistic successful OCR result with one page. */
export function makeOcrResult(over: Partial<OcrResult> = {}): OcrResult {
  const pages = over.pages ?? [makeOcrPage()]
  const combinedMarkdown = over.combinedMarkdown ?? pages.map((p) => p.markdown).join("\n\n---\n\n")
  return {
    providerId: "mistral-ocr",
    pages,
    combinedMarkdown,
    combinedText: over.combinedText ?? pages.map((p) => p.text).join("\n"),
    languages: ["en"],
    durationMs: 1240,
    cached: false,
    ...over,
  }
}

/** Settings blob; defaults to the shipped defaults. */
export function makeOcrSettings(over: Partial<UserOcrSettings> = {}): UserOcrSettings {
  return { ...DEFAULT_OCR_SETTINGS, ...over }
}

/** A representative spread of sidebar rows across every category + status. */
export const SAMPLE_SIDEBAR_PROVIDERS: OcrSidebarProvider[] = [
  {
    id: "mistral-ocr",
    name: "Mistral OCR",
    subtitle: "Document OCR (cloud)",
    status: "connected",
    category: "document-cloud",
  },
  {
    id: "google-vision",
    name: "Google Vision",
    subtitle: "Document OCR (cloud)",
    status: "not-configured",
    category: "document-cloud",
  },
  {
    id: "anthropic-vision",
    name: "Claude (vision)",
    subtitle: "LLM vision (cloud)",
    status: "not-configured",
    category: "llm-vision",
  },
  {
    id: "mathpix",
    name: "Mathpix",
    subtitle: "Specialist",
    status: "error",
    category: "specialist",
  },
  {
    id: "lark-basic",
    name: "Lark OCR",
    subtitle: "Lark",
    status: "connected",
    category: "lark",
  },
  {
    id: "ocrs",
    name: "ocrs (local)",
    subtitle: "On-device",
    status: "ready",
    category: "local",
  },
  {
    id: "windows-media-ocr",
    name: "Windows Media OCR",
    subtitle: "On-device",
    status: "unsupported",
    category: "local",
    disabled: true,
  },
]

/** Provider options for the Compare view picker. */
export const SAMPLE_COMPARE_PROVIDERS: OcrCompareProviderOption[] = [
  { id: "mistral-ocr", label: "Mistral OCR" },
  { id: "google-vision", label: "Google Vision" },
  { id: "paddle-ocr", label: "PaddleOCR" },
  { id: "tesseract-wasm", label: "Tesseract (WASM)" },
  { id: "anthropic-vision", label: "Claude (vision)" },
]
