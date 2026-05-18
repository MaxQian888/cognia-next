/**
 * OCR.space provider — free-tier friendly cloud OCR.
 *
 * Endpoint: POST https://api.ocr.space/parse/image
 *   form-urlencoded fields: apikey, base64Image=<data-url>, language, OCREngine,
 *                            isTable, scale, detectOrientation, isOverlayRequired
 *   response: { ParsedResults: [{ ParsedText, ParsedTextFileUrl, ... }], IsErroredOnProcessing, ErrorMessage }
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

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image"

export interface OcrSpaceConfig {
  endpoint?: string
  /** "1" | "2" | "3" — engine 3 supports more languages but is slower. */
  engine?: "1" | "2" | "3"
  isTable?: boolean
  scale?: boolean
  detectOrientation?: boolean
  fetchImpl?: typeof fetch
}

interface OcrSpaceParsedResult {
  ParsedText?: string
  FileParseExitCode?: number
  ErrorMessage?: string
}
interface OcrSpaceResponse {
  ParsedResults?: OcrSpaceParsedResult[]
  IsErroredOnProcessing?: boolean
  ErrorMessage?: string[] | string
  OCRExitCode?: number
}

export function buildOcrSpaceProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "ocr-space",
    label: "OCR.space",
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey"],
    async extract(input, ctx) {
      return ocrSpaceExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function ocrSpaceExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = requireSecret("ocr-space", ctx.credentials.secrets, "apiKey")
  const config = (ctx.config ?? {}) as OcrSpaceConfig
  const endpoint = config.endpoint ?? OCR_SPACE_ENDPOINT
  const engine = config.engine ?? "3"

  const normalized = await normalizeImage(input.source)
  const dataUrl = bytesToDataUrl(normalized.bytes, normalized.mimeType)
  const form = new URLSearchParams()
  form.set("apikey", apiKey)
  form.set("base64Image", dataUrl)
  form.set("OCREngine", engine)
  form.set("isTable", String(!!config.isTable))
  form.set("scale", String(!!config.scale))
  form.set("detectOrientation", String(config.detectOrientation !== false))
  if (input.languages?.[0]) form.set("language", mapLanguage(input.languages[0]))
  form.set("isOverlayRequired", "false")

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "ocr-space",
    url: endpoint,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<OcrSpaceResponse>("ocr-space", res.body)
  if (data.IsErroredOnProcessing) {
    const messages = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join("; ")
      : (data.ErrorMessage ?? "OCR.space error")
    const code = /rate.?limit|throttl/i.test(messages)
      ? "rate_limited"
      : /apikey|unauthorized|invalid/i.test(messages)
        ? "missing_credentials"
        : /language|unsupported/i.test(messages)
          ? "unsupported_language"
          : "provider_failed"
    throw new OcrError(code, "ocr-space", messages)
  }
  const text = (data.ParsedResults ?? []).map((p) => p.ParsedText ?? "").join("\n")
  return {
    providerId: "ocr-space",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

/** OCR.space uses ISO-639-2 codes like `eng`, `chs`, `jpn`. Map common ones. */
function mapLanguage(bcp47: string): string {
  const lower = bcp47.toLowerCase().split("-")[0]
  switch (lower) {
    case "en":
      return "eng"
    case "zh":
      return "chs"
    case "ja":
      return "jpn"
    case "ko":
      return "kor"
    case "de":
      return "ger"
    case "fr":
      return "fre"
    case "es":
      return "spa"
    case "it":
      return "ita"
    case "pt":
      return "por"
    case "ru":
      return "rus"
    case "ar":
      return "ara"
    case "th":
      return "tha"
    default:
      return lower
  }
}

export const ocrSpaceProvider = buildOcrSpaceProvider()
