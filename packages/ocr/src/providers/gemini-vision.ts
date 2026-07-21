/**
 * Google Gemini OCR (vision) provider.
 *
 * Reuses the user's main Gemini API key (provider settings). POSTs to
 * https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 * with a `parts` array containing inline image data + transcription prompt.
 */

import { bytesToBase64 } from "../image-prep"
import { OcrError } from "../errors"
import { type OcrInput, type OcrProvider, type OcrProviderContext, type OcrResult } from "../types"
import { cloudFetch, parseJson } from "./_http"
import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_VISION_PROMPT,
  buildVisionResult,
  preparePromptAndImage,
  type VisionConfig,
} from "./_llm-vision"

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
// gemini-2.5-pro is deprecated (shutdown 2026-10-16); gemini-3.5-flash is the
// current GA multimodal model suited to OCR transcription.
const DEFAULT_MODEL = "gemini-3.5-flash"

export interface GeminiVisionConfig extends VisionConfig {
  maxTokens?: number
}

interface GeminiTextPart {
  text?: string
}
interface GeminiCandidate {
  content?: { parts?: GeminiTextPart[] }
  finishReason?: string
}
interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}
interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsage
  error?: { code?: number; message?: string; status?: string }
}

export function buildGeminiVisionProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "gemini-vision",
    label: "Gemini (vision)",
    category: "llm-vision",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    reusesMainProviderKey: true,
    async extract(input, ctx) {
      return geminiVisionExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function geminiVisionExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = await resolveGeminiKey(ctx)
  const config = (ctx.config ?? {}) as GeminiVisionConfig
  const model = config.model || DEFAULT_MODEL
  const maxTokens = config.maxTokens ?? 4096
  const endpoint = config.endpoint || `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`

  const { prompt, mimeType, bytes } = await preparePromptAndImage(input, ctx, {
    model,
    promptTemplate: config.promptTemplate || DEFAULT_VISION_PROMPT,
    maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
  })
  const base64 = bytesToBase64(bytes)

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "gemini-vision",
    url: `${endpoint}?key=${encodeURIComponent(apiKey)}`,
    body: {
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }],
        },
      ],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<GeminiResponse>("gemini-vision", res.body)
  if (data.error) {
    const code = mapGeminiErrorCode(data.error.code, data.error.status)
    throw new OcrError(code, "gemini-vision", data.error.message ?? data.error.status ?? "error")
  }
  const candidate = data.candidates?.[0]
  if (candidate?.finishReason === "MAX_TOKENS") {
    // No degraded-output channel exists on OcrResult, so surface the
    // truncation and return the partial transcription instead of throwing.
    console.warn(
      "[ocr:gemini-vision] response truncated at maxOutputTokens; returning partial text"
    )
  }
  const markdown = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim()
  const result = buildVisionResult("gemini-vision", markdown, input, start)
  if (data.usageMetadata) {
    const promptTokens = data.usageMetadata.promptTokenCount ?? 0
    const completionTokens = data.usageMetadata.candidatesTokenCount ?? 0
    // Gemini 3.5 Flash list pricing: $1.50/M in + $9/M out (2026-Q2).
    result.costEstimate = {
      unit: "token",
      amount: (promptTokens * 1.5) / 1_000_000 + (completionTokens * 9) / 1_000_000,
      currency: "USD",
    }
  }
  return result
}

function mapGeminiErrorCode(
  code: number | undefined,
  status: string | undefined
): OcrError["code"] {
  const lowerStatus = (status ?? "").toLowerCase()
  if (code === 429 || lowerStatus.includes("resource_exhausted")) return "rate_limited"
  if (code === 400 || lowerStatus.includes("invalid_argument")) return "invalid_input"
  if (code === 401 || code === 403 || lowerStatus.includes("unauthenticated")) {
    return "missing_credentials"
  }
  return "provider_failed"
}

async function resolveGeminiKey(ctx: OcrProviderContext): Promise<string> {
  const direct = ctx.credentials.secrets["apiKey"]
  if (direct && direct.length > 0) return direct
  const fromMain = await ctx.credentials.getMainProviderKey?.("gemini")
  if (fromMain && fromMain.length > 0) {
    return fromMain
  }
  const fallback = await ctx.credentials.getMainProviderKey?.("google")
  if (fallback && fallback.length > 0) return fallback
  throw new OcrError(
    "missing_credentials",
    "gemini-vision",
    "Gemini vision OCR needs a Google AI API key. Configure it under Settings → Providers."
  )
}

export const geminiVisionProvider = buildGeminiVisionProvider()
