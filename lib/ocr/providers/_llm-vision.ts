/**
 * Shared helpers for LLM-vision OCR providers.
 *
 * These providers don't expose bounding boxes — they just prompt a multimodal
 * model to transcribe text. The provider files (anthropic-vision,
 * openai-vision, gemini-vision) build the request body and parse the
 * provider-specific response shape; everything else (normalization, downscale,
 * fallback prompt, result wrapping) is shared here.
 */

import { downscaleImage, normalizeImage } from "../image-prep"
import type { OcrInput, OcrProviderContext, OcrResult } from "../types"

export const DEFAULT_VISION_PROMPT =
  "Extract every word of text from the supplied page image and return it as well-structured Markdown. Preserve tables, lists, and reading order. Do not add commentary."

export const DEFAULT_MAX_IMAGE_DIMENSION = 2000

/** Per-provider config blocks share these fields. */
export interface VisionConfig {
  model?: string
  promptTemplate?: string
  maxImageDimension?: number
  endpoint?: string
  fetchImpl?: typeof fetch
}

/**
 * Resolve the prompt + downscaled image bytes shared across all three
 * LLM-vision providers.
 */
export async function preparePromptAndImage(
  input: OcrInput,
  ctx: OcrProviderContext,
  config: VisionConfig
): Promise<{ prompt: string; mimeType: string; bytes: Uint8Array }> {
  const normalized = await normalizeImage(input.source)
  const maxDim = config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION
  const downscaled = await downscaleImage(normalized.bytes, normalized.mimeType, maxDim)
  return {
    prompt: (config.promptTemplate || DEFAULT_VISION_PROMPT).trim(),
    mimeType: downscaled.mimeType,
    bytes: downscaled.bytes,
  }
}

/** Wrap an LLM markdown output into the single-page OcrResult shape. */
export function buildVisionResult(
  providerId: string,
  markdown: string,
  input: OcrInput,
  start: number
): OcrResult {
  const text = markdownToPlainText(markdown)
  return {
    providerId,
    pages: [{ pageNumber: 1, markdown, text }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim()
}
