/**
 * ElevenLabs TTS — direct REST call against
 * `https://api.elevenlabs.io/v1/text-to-speech/<voice>`. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\elevenlabs-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import {
  ttsFailure,
  TTS_PROVIDERS,
  type ElevenLabsTTSModel,
  type ElevenLabsTTSVoice,
  type TTSResponse,
} from "../types"

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
    return ttsFailure("api-key-missing")
  }
  const max = TTS_PROVIDERS.elevenlabs.maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
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
      return ttsFailure("api-error", {
        status: response.status,
        providerMessage: err.detail?.message ?? `API error: ${response.status}`,
      })
    }
    return {
      success: true,
      audioData: response.bytes,
      mimeType: "audio/mpeg",
    }
  } catch (error) {
    return ttsFailure("api-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
