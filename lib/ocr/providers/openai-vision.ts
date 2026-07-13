/**
 * OpenAI (GPT-5.6 family) OCR (vision) provider.
 *
 * Reuses the user's main OpenAI API key (provider settings). POSTs to
 * https://api.openai.com/v1/chat/completions with a multimodal user message
 * (image_url + transcription prompt) and returns the assistant Markdown.
 */

import { bytesToDataUrl } from "../image-prep"
import { OcrError } from "@/lib/ocr/errors"
import {
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
import { cloudFetch, parseJson } from "./_http"
import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_VISION_PROMPT,
  buildVisionResult,
  preparePromptAndImage,
  type VisionConfig,
} from "./_llm-vision"

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"
const DEFAULT_MODEL = "gpt-5.6"

export interface OpenAiVisionConfig extends VisionConfig {
  maxTokens?: number
  organization?: string
}

interface OpenAiChoice {
  message?: { content?: string }
  finish_reason?: string
}
interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}
interface OpenAiChatResponse {
  choices?: OpenAiChoice[]
  usage?: OpenAiUsage
  error?: { type?: string; message?: string; code?: string }
}

export function buildOpenAiVisionProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "openai-vision",
    label: "OpenAI (vision)",
    category: "llm-vision",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    reusesMainProviderKey: true,
    async extract(input, ctx) {
      return openAiVisionExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function openAiVisionExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = await resolveOpenAiKey(ctx)
  const config = (ctx.config ?? {}) as OpenAiVisionConfig
  const model = config.model || DEFAULT_MODEL
  const maxTokens = config.maxTokens ?? 4096
  const endpoint = config.endpoint || OPENAI_ENDPOINT

  const { prompt, mimeType, bytes } = await preparePromptAndImage(input, ctx, {
    model,
    promptTemplate: config.promptTemplate || DEFAULT_VISION_PROMPT,
    maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
  })
  const dataUrl = bytesToDataUrl(bytes, mimeType)

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (config.organization) headers["OpenAI-Organization"] = config.organization

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "openai-vision",
    url: endpoint,
    headers,
    body: {
      model,
      // GPT-5-family / o-series models reject the legacy `max_tokens` param
      // with a 400; `max_completion_tokens` is the accepted replacement.
      max_completion_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<OpenAiChatResponse>("openai-vision", res.body)
  if (data.error) {
    const code =
      data.error.code === "rate_limit_exceeded" || data.error.type === "rate_limit_exceeded"
        ? "rate_limited"
        : data.error.type === "invalid_request_error"
          ? "invalid_input"
          : data.error.type === "authentication_error"
            ? "missing_credentials"
            : "provider_failed"
    throw new OcrError(code, "openai-vision", data.error.message ?? data.error.type ?? "error")
  }
  const markdown = (data.choices?.[0]?.message?.content ?? "").trim()
  const result = buildVisionResult("openai-vision", markdown, input, start)
  if (data.usage) {
    const promptTokens = data.usage.prompt_tokens ?? 0
    const completionTokens = data.usage.completion_tokens ?? 0
    // GPT-5.6 (gpt-5.6-sol) list pricing: $5/M in + $30/M out (2026-Q2).
    result.costEstimate = {
      unit: "token",
      amount: (promptTokens * 5) / 1_000_000 + (completionTokens * 30) / 1_000_000,
      currency: "USD",
    }
  }
  return result
}

async function resolveOpenAiKey(ctx: OcrProviderContext): Promise<string> {
  const direct = ctx.credentials.secrets["apiKey"]
  if (direct && direct.length > 0) return direct
  const fromMain = await ctx.credentials.getMainProviderKey?.("openai")
  if (fromMain && fromMain.length > 0) return fromMain
  throw new OcrError(
    "missing_credentials",
    "openai-vision",
    "OpenAI vision OCR needs an OpenAI API key. Configure it under Settings → Providers."
  )
}

export const openAiVisionProvider = buildOpenAiVisionProvider()
