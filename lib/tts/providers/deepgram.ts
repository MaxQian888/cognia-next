/**
 * Deepgram Aura-2 TTS — enterprise-grade low-latency TTS.
 * Ported from `D:\Project\Cognia\lib\ai\tts\providers\deepgram-tts.ts`.
 */

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import {
  getTTSError,
  TTS_PROVIDERS,
  type DeepgramTTSVoice,
  type TTSResponse,
} from "@/lib/tts/types"

const DEEPGRAM_API_BASE = "https://api.deepgram.com/v1/speak"

export interface DeepgramTTSOptions {
  apiKey: string
  voice?: DeepgramTTSVoice
  encoding?: "mp3" | "linear16" | "aac" | "opus" | "flac"
  container?: "none" | "wav"
  sampleRate?: number
}

export async function generateDeepgramTTS(
  text: string,
  options: DeepgramTTSOptions
): Promise<TTSResponse> {
  const { apiKey, voice = "aura-2-asteria-en", encoding = "mp3", container, sampleRate } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.deepgram.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  try {
    const params = new URLSearchParams({ model: voice, encoding })
    if (container) params.set("container", container)
    if (sampleRate) params.set("sample_rate", String(sampleRate))

    const response = await proxyFetch(`${DEEPGRAM_API_BASE}?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      json: { text },
    })

    if (!response.ok) {
      const err = await response
        .json<{ err_msg?: string }>()
        .catch(() => ({}) as { err_msg?: string })
      return {
        success: false,
        error: getTTSError("api-error", err.err_msg ?? `API error: ${response.status}`).message,
      }
    }

    const mime =
      encoding === "mp3"
        ? "audio/mpeg"
        : encoding === "linear16"
          ? "audio/wav"
          : encoding === "aac"
            ? "audio/aac"
            : encoding === "opus"
              ? "audio/opus"
              : encoding === "flac"
                ? "audio/flac"
                : "audio/mpeg"
    return { success: true, audioData: response.bytes, mimeType: mime }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : "Unknown error")
        .message,
    }
  }
}
