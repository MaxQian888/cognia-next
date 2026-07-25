/**
 * Mistral Voxtral TTS via the synchronous `/v1/audio/speech` endpoint.
 *
 * The endpoint returns base64 audio in JSON. Streaming is supported upstream,
 * but this adapter intentionally uses the finished-buffer path so it fits the
 * existing chunk cache and playback pipeline.
 */

import { proxyFetch } from "../proxy-fetch"
import {
  TTS_PROVIDERS,
  ttsFailure,
  type MistralTTSModel,
  type MistralTTSResponseFormat,
  type TTSResponse,
} from "../types"

const MISTRAL_TTS_URL = "https://api.mistral.ai/v1/audio/speech"

export interface MistralTTSOptions {
  apiKey: string
  voiceId?: string
  model?: MistralTTSModel
  responseFormat?: MistralTTSResponseFormat
}

export async function generateMistralTTS(
  text: string,
  options: MistralTTSOptions
): Promise<TTSResponse> {
  const { apiKey, voiceId = "", model = "voxtral-mini-tts-2603", responseFormat = "mp3" } = options

  if (!apiKey) return ttsFailure("api-key-missing")
  if (!voiceId.trim()) {
    return ttsFailure("voice-not-found", {
      providerMessage: "Create or select a Mistral reusable voice ID first",
    })
  }

  const max = TTS_PROVIDERS.mistral.maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
  }

  try {
    const response = await proxyFetch(MISTRAL_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      json: {
        input: text,
        model,
        voice_id: voiceId.trim(),
        response_format: responseFormat,
        stream: false,
      },
    })

    if (!response.ok) {
      const error = await response
        .json<{ message?: string; error?: { message?: string } }>()
        .catch(() => ({}) as { message?: string; error?: { message?: string } })
      return ttsFailure("api-error", {
        status: response.status,
        providerMessage:
          error.message ?? error.error?.message ?? `Mistral API error: ${response.status}`,
      })
    }

    const payload = await response.json<{ audio_data?: string }>()
    if (!payload.audio_data) {
      return ttsFailure("api-error", { providerMessage: "No audio data in response" })
    }
    const bytes = base64ToArrayBuffer(payload.audio_data)
    return { success: true, audioData: bytes, mimeType: mimeTypeFor(responseFormat) }
  } catch (error) {
    return ttsFailure("network-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function mimeTypeFor(format: MistralTTSResponseFormat): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg"
    case "wav":
      return "audio/wav"
    case "pcm":
      return "audio/pcm"
    case "flac":
      return "audio/flac"
    case "opus":
      return "audio/opus"
  }
}
