/**
 * LMNT TTS — ultra-low-latency neural voice. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\lmnt-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import { ttsFailure, TTS_PROVIDERS, type LMNTTTSVoice, type TTSResponse } from "../types"

export interface LMNTTTSOptions {
  apiKey: string
  voice?: LMNTTTSVoice
  speed?: number
  format?: "mp3" | "wav"
  language?: string
  sampleRate?: number
  signal?: AbortSignal
  requestId?: string
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
    return ttsFailure("api-key-missing")
  }
  const max = TTS_PROVIDERS.lmnt.maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
  }

  try {
    const response = await proxyFetch("https://api.lmnt.com/v1/ai/speech/bytes", {
      method: "POST",
      provider: "lmnt",
      signal: options.signal,
      requestId: options.requestId,
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
      return ttsFailure("api-error", {
        status: response.status,
        providerMessage: err.error ?? `API error: ${response.status}`,
      })
    }
    return {
      success: true,
      audioData: response.bytes,
      mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
    }
  } catch (error) {
    return ttsFailure("api-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
