/**
 * Image-to-text captioning via Vercel AI SDK vision-capable models.
 *
 * Used by `lib/ai/embedding/multimodal-embedding.generateMultimodalEmbeddingAsync`
 * to convert an image into a short text caption that can then be fed into
 * a regular text-embedding model. This sidesteps shipping a local CLIP /
 * SigLIP runtime while still producing semantically meaningful image
 * vectors (the captioner sees the image, the embedder sees its description).
 *
 * Supports OpenAI (`gpt-4o-mini` by default), Anthropic (Claude vision
 * models), and Google (Gemini). Other providers throw at the
 * `getProviderModel` layer — caller is responsible for picking a vision-
 * capable provider.
 */

import { generateText } from "ai"
import { getProviderModel } from "@cognia/provider-core/core/client"
import type { ApiFlavor } from "@cognia/provider-types/provider"

/**
 * Vision-capable providers we wire up. Declared as a literal union directly
 * (rather than `Extract<ProviderName, …>`) because `ProviderName` includes
 * the open `string` index, and `Extract<string, "openai">` evaluates to
 * `never`.
 */
export type ImageCaptionProvider = "openai" | "anthropic" | "google"

export interface ImageCaptionOptions {
  /** API key for the chosen provider. */
  apiKey: string
  /** Provider that owns a vision-capable model. */
  provider?: ImageCaptionProvider
  /** Override the captioning model. */
  model?: string
  /** Override the captioning prompt. Default asks for ≤1-sentence description. */
  prompt?: string
  /** Optional override for the output token cap. */
  maxTokens?: number
  /** Custom base URL (e.g. for OpenAI-compatible proxies). */
  baseURL?: string
  /** OpenAI endpoint family override for compatible proxies / Azure-like gateways. */
  apiFlavor?: ApiFlavor
  /** Extra provider headers (e.g. Codex/ChatGPT-login account headers). */
  headers?: Record<string, string>
}

const DEFAULT_MODELS: Record<"openai" | "anthropic" | "google", string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
}

const DEFAULT_PROMPT =
  "Describe this image in one concise sentence. Focus on the main subject, scene, and any visible text. Do not editorialise; do not start with 'The image shows'."

/**
 * Generate a one-sentence caption for `image`.
 *
 * `image` accepts:
 *  - a `data:` URL (`data:image/png;base64,…`) — passed through verbatim
 *  - a remote `http(s):` URL — fetched by the provider
 *  - an `ArrayBuffer` / `Uint8Array` — uploaded as bytes
 *
 * @throws if the provider rejects the request, the model returns an empty
 * caption, or `apiKey` is missing.
 */
export async function generateImageCaption(
  image: string | ArrayBuffer | Uint8Array,
  options: ImageCaptionOptions
): Promise<string> {
  if (!options.apiKey) {
    throw new Error("generateImageCaption: apiKey is required")
  }
  const provider = options.provider ?? "openai"
  const model = options.model ?? DEFAULT_MODELS[provider]
  const modelInstance = getProviderModel({
    provider,
    model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    apiFlavor: options.apiFlavor,
    headers: options.headers,
  })

  const imagePart = toImagePart(image)
  const result = await generateText({
    model: modelInstance,
    maxOutputTokens: options.maxTokens ?? 200,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: options.prompt ?? DEFAULT_PROMPT }, imagePart],
      },
    ],
  })

  const caption = (result.text ?? "").trim()
  if (!caption) {
    throw new Error(
      `generateImageCaption: ${provider}/${model} returned empty text. Check provider quota / model selection.`
    )
  }
  return caption
}

type ImagePart = {
  type: "image"
  image: string | ArrayBuffer | Uint8Array | URL
}

function toImagePart(image: string | ArrayBuffer | Uint8Array): ImagePart {
  if (typeof image === "string") {
    return { type: "image", image }
  }
  return { type: "image", image }
}
