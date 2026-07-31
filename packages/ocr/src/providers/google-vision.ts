/**
 * Google Cloud Vision OCR provider.
 *
 * Endpoint: POST https://vision.googleapis.com/v1/images:annotate?key=<API_KEY>
 *   body: { requests: [{ image: { content: <base64> }, features: [{ type, maxResults? }] }] }
 *   response: { responses: [{ fullTextAnnotation: {...}, textAnnotations: [...], error?: {...} }] }
 *
 * Returns plain text (assembled into Markdown paragraphs) plus per-word blocks
 * with bounding boxes and confidence scores.
 */

import { bytesToBase64, downscaleImage, normalizeImage } from "../image-prep"
import { OcrError } from "../errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, parseJson, requireSecret } from "./_http"
import { DEFAULT_MAX_IMAGE_DIMENSION } from "./_llm-vision"

const GOOGLE_VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"

type GoogleVisionFeatureType = "DOCUMENT_TEXT_DETECTION" | "TEXT_DETECTION"

export interface GoogleVisionConfig {
  endpoint?: string
  /**
   * Feature type to request — typically DOCUMENT_TEXT_DETECTION. The settings
   * UI stores this under the shared `model` key; `featureType` is the legacy
   * fallback.
   */
  model?: string
  featureType?: GoogleVisionFeatureType
  /** Long-edge cap applied before upload (shared OCR param). */
  maxImageDimension?: number
  fetchImpl?: typeof fetch
}

interface GVVertex {
  x?: number
  y?: number
}
interface GVBoundingPoly {
  vertices?: GVVertex[]
}
interface GVTextSymbol {
  text?: string
  confidence?: number
}
interface GVWord {
  symbols?: GVTextSymbol[]
  boundingBox?: GVBoundingPoly
  confidence?: number
}
interface GVParagraph {
  words?: GVWord[]
  boundingBox?: GVBoundingPoly
  confidence?: number
}
interface GVBlock {
  paragraphs?: GVParagraph[]
  boundingBox?: GVBoundingPoly
  confidence?: number
}
interface GVPage {
  blocks?: GVBlock[]
  width?: number
  height?: number
}
interface GVFullTextAnnotation {
  text?: string
  pages?: GVPage[]
}
interface GVResponse {
  responses?: Array<{
    fullTextAnnotation?: GVFullTextAnnotation
    // google.rpc.Status — `code` is a gRPC canonical code (not HTTP).
    error?: { code?: number; message?: string; status?: string }
  }>
}

export function buildGoogleVisionProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "google-vision",
    label: "Google Cloud Vision",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey"],
    async extract(input, ctx) {
      return googleVisionExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function googleVisionExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = requireSecret("google-vision", ctx.credentials.secrets, "apiKey")
  const config = (ctx.config ?? {}) as GoogleVisionConfig
  const featureType = resolveFeatureType(config)
  const endpoint = config.endpoint ?? GOOGLE_VISION_ENDPOINT

  const normalized = await normalizeImage(input.source)
  // Cap the long edge so large captures stay under the 10MB JSON request limit.
  const downscaled = await downscaleImage(
    normalized.bytes,
    normalized.mimeType,
    config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION
  )
  const content = bytesToBase64(downscaled.bytes)
  const start = Date.now()
  const res = await cloudFetch({
    providerId: "google-vision",
    url: `${endpoint}?key=${encodeURIComponent(apiKey)}`,
    body: {
      requests: [
        {
          image: { content },
          features: [{ type: featureType }],
          imageContext: input.languages ? { languageHints: input.languages } : undefined,
        },
      ],
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<GVResponse>("google-vision", res.body)
  const first = data.responses?.[0]
  if (first?.error) {
    throw new OcrError(
      mapRpcStatus(first.error.code, first.error.status),
      "google-vision",
      first.error.message ?? "Google Vision returned an error"
    )
  }
  const annotation = first?.fullTextAnnotation
  const pages = annotation?.pages?.length
    ? annotation.pages.map((page, idx) => buildPage(page, idx + 1))
    : [
        {
          pageNumber: 1,
          markdown: annotation?.text ?? "",
          text: annotation?.text ?? "",
          blocks: [] as OcrBlock[],
        },
      ]

  return {
    providerId: "google-vision",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

function resolveFeatureType(config: GoogleVisionConfig): GoogleVisionFeatureType {
  // The settings UI writes the feature type to the shared `model` key.
  if (config.model === "DOCUMENT_TEXT_DETECTION" || config.model === "TEXT_DETECTION") {
    return config.model
  }
  return config.featureType ?? "DOCUMENT_TEXT_DETECTION"
}

/**
 * Map a per-response google.rpc.Status onto OcrError codes. `code` uses gRPC
 * canonical values (8 = RESOURCE_EXHAUSTED, 3 = INVALID_ARGUMENT,
 * 7 = PERMISSION_DENIED, 16 = UNAUTHENTICATED), never HTTP status numbers.
 */
function mapRpcStatus(code: number | undefined, status: string | undefined): OcrError["code"] {
  const upper = (status ?? "").toUpperCase()
  if (code === 8 || upper === "RESOURCE_EXHAUSTED") return "rate_limited"
  if (code === 3 || upper === "INVALID_ARGUMENT") return "invalid_input"
  if (code === 7 || code === 16 || upper === "PERMISSION_DENIED" || upper === "UNAUTHENTICATED") {
    return "missing_credentials"
  }
  return "provider_failed"
}

function buildPage(page: GVPage, pageNumber: number) {
  const blocks: OcrBlock[] = []
  const paragraphs: string[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      const text = paragraphText(paragraph)
      if (text) paragraphs.push(text)
      blocks.push({
        text,
        bbox: vertexBoundingBox(paragraph.boundingBox),
        confidence: paragraph.confidence,
        kind: "paragraph",
      })
    }
  }
  const text = paragraphs.join("\n\n")
  return {
    pageNumber,
    markdown: text,
    text,
    blocks,
    width: page.width,
    height: page.height,
  }
}

function paragraphText(paragraph: GVParagraph): string {
  if (!paragraph.words) return ""
  return paragraph.words
    .map((w) => (w.symbols ?? []).map((s) => s.text ?? "").join(""))
    .join(" ")
    .trim()
}

function vertexBoundingBox(poly: GVBoundingPoly | undefined): OcrBlock["bbox"] | undefined {
  if (!poly || !poly.vertices || poly.vertices.length === 0) return undefined
  const xs = poly.vertices.map((v) => v.x ?? 0)
  const ys = poly.vertices.map((v) => v.y ?? 0)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  }
}

export const googleVisionProvider = buildGoogleVisionProvider()
