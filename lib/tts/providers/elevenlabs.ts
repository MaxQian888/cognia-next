/**
 * ElevenLabs TTS — direct REST call against
 * `https://api.elevenlabs.io/v1/text-to-speech/<voice>`. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\elevenlabs-tts.ts`.
 */

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import {
  getTTSError,
  TTS_PROVIDERS,
  type ElevenLabsTTSModel,
  type ElevenLabsTTSVoice,
  type TTSResponse,
} from "@/lib/tts/types"

export interface ElevenLabsTTSOptions {
  apiKey: string
  voice?: ElevenLabsTTSVoice
  model?: ElevenLabsTTSModel
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
}

export async function generateElevenLabsTTS(
  text: string,
  options: ElevenLabsTTSOptions
): Promise<TTSResponse> {
  const {
    apiKey,
    voice = "rachel",
    model = "eleven_multilingual_v2",
    stability = 0.5,
    similarityBoost = 0.75,
  } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.elevenlabs.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  try {
    const response = await proxyFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      json: {
        text,
        model_id: model,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
        },
      },
    })

    if (!response.ok) {
      const err = await response
        .json<{ detail?: { message?: string } }>()
        .catch(() => ({}) as { detail?: { message?: string } })
      return {
        success: false,
        error: getTTSError("api-error", err.detail?.message ?? `API error: ${response.status}`)
          .message,
      }
    }
    return {
      success: true,
      audioData: response.bytes,
      mimeType: "audio/mpeg",
    }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : "Unknown error")
        .message,
    }
  }
}
