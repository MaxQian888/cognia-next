/**
 * OpenAI TTS — neural voices via the `/v1/audio/speech` REST endpoint.
 * Ported from `D:\Project\Cognia\lib\ai\tts\providers\openai-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import { normalizeAudioMime } from "../audio-response"
import {
  ttsFailure,
  TTS_PROVIDERS,
  type OpenAITTSModel,
  type OpenAITTSVoice,
  type BufferedTTSResponseFormat,
  type TTSResponse,
} from "../types"

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"

export interface OpenAITTSOptions {
  apiKey: string
  voice?: OpenAITTSVoice
  model?: OpenAITTSModel
  speed?: number
  instructions?: string
  responseFormat?: BufferedTTSResponseFormat
  signal?: AbortSignal
  requestId?: string
}

export async function generateOpenAITTS(
  text: string,
  options: OpenAITTSOptions
): Promise<TTSResponse> {
  const {
    apiKey,
    voice = "alloy",
    model = "gpt-4o-mini-tts",
    speed = 1.0,
    instructions,
    responseFormat = "mp3",
  } = options

  if (!apiKey) {
    return ttsFailure("api-key-missing")
  }
  const max = TTS_PROVIDERS.openai.maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
  }

  const body: Record<string, unknown> = {
    model,
    input: text,
    voice,
    speed: Math.min(4.0, Math.max(0.25, speed)),
    response_format: responseFormat,
  }
  if (instructions && model === "gpt-4o-mini-tts") {
    body.instructions = instructions
  }

  try {
    const response = await proxyFetch(OPENAI_TTS_URL, {
      method: "POST",
      provider: "openai",
      signal: options.signal,
      requestId: options.requestId,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      json: body,
    })

    if (!response.ok) {
      const err = await response
        .json<{ error?: { message?: string } }>()
        .catch(() => ({}) as { error?: { message?: string } })
      return ttsFailure("api-error", {
        status: response.status,
        providerMessage: err.error?.message ?? `API error: ${response.status}`,
      })
    }

    const normalized = normalizeAudioMime(response.mime, responseFormat)
    if (!normalized.success) return normalized
    return { success: true, audioData: response.bytes, mimeType: normalized.mimeType }
  } catch (error) {
    return ttsFailure("network-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
