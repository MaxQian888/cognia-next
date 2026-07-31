/**
 * OCR subsystem — public types.
 *
 * Cross-shell text extraction from images and PDFs. Provider implementations
 * live under `lib/ocr/providers/*`; the public surface is `extract()` from
 * `lib/ocr/index.ts`. The `OcrError` runtime class lives in `lib/ocr/errors.ts`
 * (runtime code stays out of `types/`); its discriminant `OcrErrorCode` is
 * defined here. See `docs/content/docs/en/adr/0024-ocr-subsystem.md`.
 */

import type { NativePlatform } from "./platform"

export type {
  OcrDocument,
  OcrDocumentPage,
  OcrDocumentBlock,
  OcrDocumentBlockType,
} from "./document"
import type { OcrDocument } from "./document"

/** Logical grouping used by the settings UI sidebar. */
export type OcrProviderCategory = "document-cloud" | "llm-vision" | "specialist" | "lark" | "local"

/** Which shells a provider can run in. */
export interface OcrProviderShellSupport {
  browser: boolean
  tauri: boolean
  capacitor: boolean
}

/** Output format selection. */
export type OcrOutputFormat = "markdown" | "text" | "blocks"

/** Block kinds returned by providers that expose structured output. */
export type OcrBlockKind = "paragraph" | "line" | "word" | "table" | "formula"

/** A single recognized region with optional bounding box and confidence. */
export interface OcrBlock {
  text: string
  /** Normalized bbox in page coordinates (px). Origin top-left. */
  bbox?: { x: number; y: number; width: number; height: number }
  /** 0..1 — provider native confidence (rescale where necessary). */
  confidence?: number
  kind?: OcrBlockKind
}

/** Per-page OCR output. */
export interface OcrPage {
  /** 1-based page number. */
  pageNumber: number
  /** Markdown rendering — always populated, even by text-only providers. */
  markdown: string
  /** Plain text — always populated. */
  text: string
  /** Structured blocks. Populated only when the provider supports them. */
  blocks?: OcrBlock[]
  /** Rasterized page width (px) when known. */
  width?: number
  /** Rasterized page height (px) when known. */
  height?: number
  /** True when this page came from the PDF text layer fast-path, not OCR. */
  fromTextLayer?: boolean
}

/**
 * The thing the caller hands to `extract()`. The discriminated `source` makes
 * data-url / blob / file-path / attachment-id all routable to the same
 * provider implementation.
 */
export type OcrSource =
  | { kind: "data-url"; dataUrl: string; mimeType: string }
  | { kind: "file-path"; path: string }
  | { kind: "blob"; blob: Blob; mimeType: string }
  | { kind: "attachment-id"; attachmentId: string }

export interface OcrInput {
  source: OcrSource
  /** BCP-47 codes or Tesseract lang triplets. Normalized internally. */
  languages?: string[]
  /** Defaults to "markdown". */
  format?: OcrOutputFormat
  /** "1,3-5,7" syntax. Page numbers are 1-based. */
  pageRange?: string
  /** Explicit provider id. Defaults to auto-router selection. */
  providerId?: string
  signal?: AbortSignal
  /**
   * Allow caching a hit / writing a fresh entry. Defaults to true. Useful for
   * health-check probes that should never read or pollute the cache.
   */
  useCache?: boolean
}

export interface OcrCostEstimate {
  unit: "page" | "image" | "token"
  amount: number
  currency: "USD"
}

export interface OcrResult {
  /** Id of the provider that produced this result. */
  providerId: string
  pages: OcrPage[]
  /** Concatenated Markdown with per-page dividers. */
  combinedMarkdown: string
  /** Concatenated plain text (newline-separated pages). */
  combinedText: string
  /** Languages used by the provider (after normalization). */
  languages: string[]
  /** Wall-clock duration of the provider call (ms). */
  durationMs: number
  /** Best-effort cost projection (provider-dependent). */
  costEstimate?: OcrCostEstimate
  /** True when this result was returned from the Dexie cache. */
  cached: boolean
  /**
   * Typed intermediate representation (ADR-0024 Phase 2). Optional + additive:
   * synthesized from `pages` by `buildOcrDocument` so citation anchors and the
   * Live-Text overlay have a uniform structure. Older cached rows may lack it.
   */
  document?: OcrDocument
}

/**
 * Error codes thrown by providers. Tests rely on the `code` discriminant rather
 * than message strings. The `OcrError` class that carries this code lives in
 * `lib/ocr/errors.ts`.
 */
export type OcrErrorCode =
  | "unsupported_shell"
  | "missing_credentials"
  | "rate_limited"
  | "provider_failed"
  | "unsupported_language"
  | "invalid_input"
  | "aborted"

/**
 * Resolved credentials passed to provider `extract()` implementations.
 *
 * `secrets` is a map of credential key → value the provider declared in its
 * registry entry. `getMainProviderKey()` is the escape hatch for LLM-vision
 * providers that reuse keys from the main provider system.
 */
export interface OcrCredentials {
  secrets: Record<string, string>
  /** Returns null when the main provider isn't configured. */
  getMainProviderKey?: (providerId: string) => Promise<string | null>
}

/**
 * Provider-specific config (model variant, language pack, prompt template).
 * Stored under `UserOcrSettings.providerConfig[providerId]`.
 */
export type OcrProviderConfig = Record<string, unknown>

export interface OcrProviderContext {
  /** Resolved credentials per the provider's credentials schema. */
  credentials: OcrCredentials
  /** Provider config from settings (model, region, language packs, etc.). */
  config: OcrProviderConfig
  /** Caller-supplied AbortSignal — providers MUST honour it for long calls. */
  signal?: AbortSignal
  /** Current shell — providers branch on this for native vs HTTP paths. */
  platform: NativePlatform
}

/** What every provider exports. The registry holds these factories. */
export interface OcrProvider {
  id: string
  label: string
  category: OcrProviderCategory
  shells: OcrProviderShellSupport
  /**
   * Names of secrets the provider needs. Empty for local engines and for
   * LLM-vision providers that reuse main provider keys.
   */
  credentialKeys: readonly string[]
  /** True when the provider reads from the main provider system (Claude/GPT/Gemini). */
  reusesMainProviderKey?: boolean
  extract(input: OcrInput, ctx: OcrProviderContext): Promise<OcrResult>
}

/** Per-OS local-engine ranking override keys. Mirrors `AutoRouterDeps.localPreference`. */
export type OcrPlatformOverrideKey = "windows" | "macos" | "linux" | "ios" | "android" | "browser"

/** Settings store shape (persisted under settings table key "ocr"). */
export interface UserOcrSettings {
  /** Provider id selected when `OcrInput.providerId` is undefined. "auto" enables the auto-router. */
  defaultProviderId: string | "auto"
  /** When true, auto-router falls back to a cloud provider if local engines are unavailable. */
  cloudFallbackEnabled: boolean
  /** Cloud provider used as the auto-router cloud fallback (e.g. "mistral-ocr"). */
  cloudFallbackProviderId: string | null
  /** Default output format used when callers don't pass one. */
  defaultFormat: OcrOutputFormat
  /** When true, PDFs go through the text-layer fast-path before OCR. */
  pdfTextLayerFastPath: boolean
  /** Per-provider config blob (model, language pack, prompt template). */
  providerConfig: Record<string, OcrProviderConfig>
  /** Per-provider enabled flag — disabled providers aren't picked by auto-router. */
  providerEnabled: Record<string, boolean>
  /** Cache TTL in days. 0 = no expiry. Default 30. */
  cacheTtlDays: number
  /** Default languages passed to providers when caller omits them. */
  defaultLanguages: string[]
  /** Maximum image long-edge in px before downscale (LLM-vision cost guard). */
  maxImageDimension: number
  /**
   * Per-OS local-engine preference override. Each entry is an ordered list of
   * provider ids (head = strongest preference). Merges *over*
   * `DEFAULT_LOCAL_PREFERENCE` — keys you don't set fall back to the default.
   * The settings UI's Platform Overrides tab drives this.
   */
  platformOverrides?: Partial<Record<OcrPlatformOverrideKey, string[]>>
  /**
   * True once the user has interacted with the first-visit setup wizard (either
   * applying a preset or dismissing it). The wizard stays out of their way
   * forever after that, except via the explicit "Open setup wizard" button.
   */
  ocrWizardDismissed?: boolean
  /**
   * Eagerly OCR inbound platform-connector images so the agent + digest can read
   * their text. Default on; the auto-router picks a local/default provider and
   * the Dexie cache dedups repeat images. Set false to disable inbound OCR.
   */
  ocrInboundImages?: boolean
  /**
   * Confidence-driven escalation (ADR-0024 Phase 2 / 2c). When `"escalate"`,
   * a result whose mean block confidence falls below `confidenceThreshold` is
   * re-OCR'd with a stronger provider (`escalationProviderId`, defaulting to the
   * cloud fallback) and the escalated result is kept. `"off"` (default) never
   * spends a second call.
   */
  confidenceEscalation?: "off" | "escalate"
  /** Mean-confidence floor (0..1) below which escalation fires. Default 0.6. */
  confidenceThreshold?: number
  /** Provider to escalate to. Null → use `cloudFallbackProviderId`. */
  escalationProviderId?: string | null
}

export const DEFAULT_OCR_SETTINGS: UserOcrSettings = {
  defaultProviderId: "auto",
  cloudFallbackEnabled: true,
  cloudFallbackProviderId: "mistral-ocr",
  defaultFormat: "markdown",
  pdfTextLayerFastPath: true,
  providerConfig: {},
  providerEnabled: {},
  cacheTtlDays: 30,
  defaultLanguages: ["en"],
  maxImageDimension: 2000,
  platformOverrides: {},
  ocrWizardDismissed: false,
  ocrInboundImages: true,
  confidenceEscalation: "off",
  confidenceThreshold: 0.6,
  escalationProviderId: null,
}
