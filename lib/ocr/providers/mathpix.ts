/**
 * Mathpix OCR provider — math/formula specialist.
 *
 * Endpoint: POST https://api.mathpix.com/v3/text
 *   headers: app_id, app_key, Content-Type: application/json
 *   body: { src: "<data-url>", formats: ["text", "data"], math_inline_delimiters: ["$","$"] }
 *   response: { text, latex_styled, data: [{ type, value }], ... }
 */

import { bytesToDataUrl, normalizeImage } from "../image-prep"
import {
  OcrError,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, parseJson, requireSecret } from "./_http"

const MATHPIX_ENDPOINT = "https://api.mathpix.com/v3/text"

export interface MathpixConfig {
  endpoint?: string
  formats?: ("text" | "data" | "latex_styled" | "html")[]
  fetchImpl?: typeof fetch
}

interface MathpixResponse {
  text?: string
  latex_styled?: string
  html?: string
  data?: Array<{ type?: string; value?: string }>
  error?: string
  error_info?: { id?: string; message?: string }
}

export function buildMathpixProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "mathpix",
    label: "Mathpix",
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["appId", "appKey"],
    async extract(input, ctx) {
      return mathpixExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function mathpixExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const appId = requireSecret("mathpix", ctx.credentials.secrets, "appId")
  const appKey = requireSecret("mathpix", ctx.credentials.secrets, "appKey")
  const config = (ctx.config ?? {}) as MathpixConfig
  const endpoint = config.endpoint ?? MATHPIX_ENDPOINT
  const formats = config.formats ?? ["text", "data"]

  const normalized = await normalizeImage(input.source)
  const dataUrl = bytesToDataUrl(normalized.bytes, normalized.mimeType)
  const start = Date.now()
  const res = await cloudFetch({
    providerId: "mathpix",
    url: endpoint,
    headers: { app_id: appId, app_key: appKey },
    body: {
      src: dataUrl,
      formats,
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<MathpixResponse>("mathpix", res.body)
  if (data.error || data.error_info) {
    const msg = data.error_info?.message ?? data.error ?? "Mathpix error"
    const code = /rate.?limit/i.test(msg)
      ? "rate_limited"
      : /unauth|invalid.*key|forbidden/i.test(msg)
        ? "missing_credentials"
        : "provider_failed"
    throw new OcrError(code, "mathpix", msg)
  }
  const markdown = data.text ?? data.latex_styled ?? data.html ?? ""
  return {
    providerId: "mathpix",
    pages: [{ pageNumber: 1, markdown, text: stripMathDelims(markdown) }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
    costEstimate: { unit: "image", amount: 0.004, currency: "USD" },
  }
}

function stripMathDelims(markdown: string): string {
  return markdown.replace(/\$\$/g, "").replace(/\$/g, "")
}

export const mathpixProvider = buildMathpixProvider()
