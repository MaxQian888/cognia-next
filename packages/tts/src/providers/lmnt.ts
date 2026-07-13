/**
 * LMNT TTS — ultra-low-latency neural voice. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\lmnt-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import { getTTSError, TTS_PROVIDERS, type LMNTTTSVoice, type TTSResponse } from "../types"

export interface LMNTTTSOptions {
  apiKey: string
  voice?: LMNTTTSVoice
  speed?: number
  format?: "mp3" | "wav"
  language?: string
  sampleRate?: number
}

export async function generateLMNTTTS(text: string, options: LMNTTTSOptions): Promise<TTSResponse> {
  const {
    apiKey,
    voice = "lily",
    speed = 1.0,
    format = "mp3",
    language = "auto",
    sampleRate = 24000,
  } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.lmnt.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  try {
    const response = await proxyFetch("https://api.lmnt.com/v1/ai/speech/bytes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      json: {
        text,
        voice,
        speed: Math.min(2.0, Math.max(0.5, speed)),
        format,
        language,
        sample_rate: sampleRate,
      },
    })

    if (!response.ok) {
      const err = await response.json<{ error?: string }>().catch(() => ({}) as { error?: string })
      return {
        success: false,
        error: getTTSError("api-error", err.error ?? `API error: ${response.status}`).message,
      }
    }
    return {
      success: true,
      audioData: response.bytes,
      mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
    }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : "Unknown error")
        .message,
    }
  }
}
