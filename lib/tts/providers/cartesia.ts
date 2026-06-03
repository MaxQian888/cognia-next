/**
 * Cartesia Sonic TTS — ultra-low latency, 42 languages, emotion knobs.
 * Ported from `D:\Project\Cognia\lib\ai\tts\providers\cartesia-tts.ts`.
 */

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import {
  getTTSError,
  TTS_PROVIDERS,
  type CartesiaTTSModel,
  type CartesiaTTSVoice,
  type TTSResponse,
} from "@/types/media/tts"

const CARTESIA_API_BASE = "https://api.cartesia.ai"
const CARTESIA_API_VERSION = "2025-04-16"

export interface CartesiaTTSOptions {
  apiKey: string
  voice?: CartesiaTTSVoice
  model?: CartesiaTTSModel
  language?: string
  speed?: number
  emotion?: string
  outputFormat?: "mp3" | "wav" | "raw"
}

export async function generateCartesiaTTS(
  text: string,
  options: CartesiaTTSOptions
): Promise<TTSResponse> {
  const {
    apiKey,
    voice = "a0e99841-438c-4a64-b679-ae501e7d6091",
    model = "sonic-3",
    language = "en",
    speed,
    emotion,
    outputFormat = "mp3",
  } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.cartesia.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  const outputFormatConfig =
    outputFormat === "mp3"
      ? { container: "mp3", bit_rate: 128000 }
      : outputFormat === "wav"
        ? { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 }
        : { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 }

  const body: Record<string, unknown> = {
    model_id: model,
    transcript: text,
    voice: { mode: "id", id: voice },
    language,
    output_format: outputFormatConfig,
  }
  const generation_config: Record<string, unknown> = {}
  if (typeof speed === "number") generation_config.speed = speed
  if (emotion && emotion.trim()) generation_config.emotion = emotion.trim()
  if (Object.keys(generation_config).length > 0) {
    body.generation_config = generation_config
  }

  try {
    const response = await proxyFetch(`${CARTESIA_API_BASE}/tts/bytes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Cartesia-Version": CARTESIA_API_VERSION,
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      json: body,
    })

    if (!response.ok) {
      const err = await response
        .json<{ message?: string }>()
        .catch(() => ({}) as { message?: string })
      return {
        success: false,
        error: getTTSError("api-error", err.message ?? `API error: ${response.status}`).message,
      }
    }

    const mime =
      outputFormat === "mp3" ? "audio/mpeg" : outputFormat === "wav" ? "audio/wav" : "audio/pcm"
    return { success: true, audioData: response.bytes, mimeType: mime }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : "Unknown error")
        .message,
    }
  }
}
