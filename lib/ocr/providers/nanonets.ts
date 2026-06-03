/**
 * Nanonets OCR provider.
 *
 * Endpoint: POST https://app.nanonets.com/api/v2/OCR/Model/<modelId>/LabelFile/
 *   Basic auth (apiKey:""), multipart form with `file` field.
 *   Response: { result: [{ prediction: [{ ocr_text, score, bbox: [x,y,w,h] }] }], ... }
 *
 * When no `modelId` is provided we use the generic Nanonets OCR model.
 */

import { normalizeImage } from "../image-prep"
import { OcrError } from "@/lib/ocr/errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
import { cloudFetch, parseJson, requireSecret } from "./_http"

const NANONETS_BASE = "https://app.nanonets.com/api/v2/OCR/Model"
/** Generic free-form OCR model id used when no `modelId` is configured. */
const NANONETS_GENERIC_MODEL = "ocr"

export interface NanonetsConfig {
  modelId?: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

interface NanonetsPrediction {
  ocr_text?: string
  label?: string
  score?: number
  xmin?: number
  ymin?: number
  xmax?: number
  ymax?: number
}
interface NanonetsResult {
  prediction?: NanonetsPrediction[]
  page?: number
  message?: string
}
interface NanonetsResponse {
  message?: string
  result?: NanonetsResult[]
  error?: string
}

export function buildNanonetsProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "nanonets",
    label: "Nanonets",
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey"],
    async extract(input, ctx) {
      return nanonetsExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function nanonetsExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = requireSecret("nanonets", ctx.credentials.secrets, "apiKey")
  const config = (ctx.config ?? {}) as NanonetsConfig
  const modelId = config.modelId || NANONETS_GENERIC_MODEL
  const endpoint = config.endpoint || `${NANONETS_BASE}/${encodeURIComponent(modelId)}/LabelFile/`

  const normalized = await normalizeImage(input.source)
  const boundary = `------OcrBoundary${Date.now().toString(36)}`
  const body = buildMultipart(boundary, normalized.bytes, normalized.mimeType, "image")
  const auth = "Basic " + base64(`${apiKey}:`)

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "nanonets",
    url: endpoint,
    headers: {
      Authorization: auth,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<NanonetsResponse>("nanonets", res.body)
  if (data.error || data.message?.toLowerCase().includes("error")) {
    throw new OcrError(
      "provider_failed",
      "nanonets",
      data.error ?? data.message ?? "Nanonets error"
    )
  }

  const pages = (data.result ?? [{}]).map((result, idx): OcrResult["pages"][number] => {
    const blocks: OcrBlock[] = (result.prediction ?? []).map((pred) => ({
      text: pred.ocr_text ?? pred.label ?? "",
      bbox:
        pred.xmin !== undefined &&
        pred.ymin !== undefined &&
        pred.xmax !== undefined &&
        pred.ymax !== undefined
          ? {
              x: pred.xmin,
              y: pred.ymin,
              width: pred.xmax - pred.xmin,
              height: pred.ymax - pred.ymin,
            }
          : undefined,
      confidence: pred.score,
      kind: "paragraph",
    }))
    const text = blocks
      .map((b) => b.text)
      .filter((s) => s.length > 0)
      .join("\n")
    return {
      pageNumber: result.page ?? idx + 1,
      markdown: text,
      text,
      blocks,
    }
  })

  return {
    providerId: "nanonets",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

function buildMultipart(
  boundary: string,
  bytes: Uint8Array,
  mimeType: string,
  fieldName: string
): Uint8Array {
  const fileName = "input.bin"
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`
  const headerBytes = new TextEncoder().encode(header)
  const footerBytes = new TextEncoder().encode(footer)
  const out = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length)
  out.set(headerBytes, 0)
  out.set(bytes, headerBytes.length)
  out.set(footerBytes, headerBytes.length + bytes.length)
  return out
}

function base64(input: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(input, "utf-8").toString("base64")
  return btoa(input)
}

export const nanonetsProvider = buildNanonetsProvider()
