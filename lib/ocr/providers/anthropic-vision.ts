/**
 * Anthropic Claude OCR (vision) provider.
 *
 * Reuses the user's main Anthropic API key (provider settings) instead of
 * asking for a second credential. POSTs to https://api.anthropic.com/v1/messages
 * with the page rendered as a base64 image block and a transcription prompt;
 * returns the assistant's Markdown reply.
 */

import { bytesToBase64 } from "../image-prep"
import {
  OcrError,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, parseJson } from "./_http"
import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_VISION_PROMPT,
  buildVisionResult,
  preparePromptAndImage,
  type VisionConfig,
} from "./_llm-vision"

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
const DEFAULT_MODEL = "claude-opus-4-7"
const DEFAULT_API_VERSION = "2023-06-01"

export interface AnthropicVisionConfig extends VisionConfig {
  apiVersion?: string
  maxTokens?: number
}

interface AnthropicTextBlock {
  type?: "text"
  text?: string
}
interface AnthropicMessageResponse {
  content?: AnthropicTextBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

export function buildAnthropicVisionProvider(
  inject: { fetchImpl?: typeof fetch } = {}
): OcrProvider {
  return {
    id: "anthropic-vision",
    label: "Claude (vision)",
    category: "llm-vision",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    reusesMainProviderKey: true,
    async extract(input, ctx) {
      return anthropicVisionExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function anthropicVisionExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = await resolveAnthropicKey(ctx)
  const config = (ctx.config ?? {}) as AnthropicVisionConfig
  const model = config.model || DEFAULT_MODEL
  const apiVersion = config.apiVersion || DEFAULT_API_VERSION
  const maxTokens = config.maxTokens ?? 4096
  const endpoint = config.endpoint || ANTHROPIC_ENDPOINT

  const { prompt, mimeType, bytes } = await preparePromptAndImage(input, ctx, {
    model,
    promptTemplate: config.promptTemplate || DEFAULT_VISION_PROMPT,
    maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
  })
  const base64 = bytesToBase64(bytes)

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "anthropic-vision",
    url: endpoint,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": apiVersion,
    },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<AnthropicMessageResponse>("anthropic-vision", res.body)
  if (data.error) {
    const code =
      data.error.type === "rate_limit_error"
        ? "rate_limited"
        : data.error.type === "authentication_error"
          ? "missing_credentials"
          : "provider_failed"
    throw new OcrError(code, "anthropic-vision", data.error.message ?? data.error.type ?? "error")
  }

  const markdown = (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim()
  const result = buildVisionResult("anthropic-vision", markdown, input, start)
  if (data.usage) {
    const input_tokens = data.usage.input_tokens ?? 0
    const output_tokens = data.usage.output_tokens ?? 0
    result.costEstimate = {
      unit: "token",
      // Opus 4.7 list pricing: $5/M in + $25/M out (2026-Q1).
      amount: (input_tokens * 5) / 1_000_000 + (output_tokens * 25) / 1_000_000,
      currency: "USD",
    }
  }
  return result
}

async function resolveAnthropicKey(ctx: OcrProviderContext): Promise<string> {
  const direct = ctx.credentials.secrets["apiKey"]
  if (direct && direct.length > 0) return direct
  const fromMain = await ctx.credentials.getMainProviderKey?.("anthropic")
  if (fromMain && fromMain.length > 0) return fromMain
  throw new OcrError(
    "missing_credentials",
    "anthropic-vision",
    "Claude vision OCR needs an Anthropic API key. Configure it under Settings → Providers."
  )
}

export const anthropicVisionProvider = buildAnthropicVisionProvider()
