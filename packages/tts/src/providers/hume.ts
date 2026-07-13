/**
 * Hume AI TTS — emotionally expressive voice synthesis. The API returns
 * base64-encoded MP3 inside a JSON envelope. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\hume-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import { getTTSError, TTS_PROVIDERS, type HumeTTSVoice, type TTSResponse } from "../types"

export interface HumeTTSOptions {
  apiKey: string
  voice?: HumeTTSVoice
  actingInstructions?: string
  sampleRate?: number
  version?: 1 | 2
}

export async function generateHumeTTS(text: string, options: HumeTTSOptions): Promise<TTSResponse> {
  const { apiKey, voice = "kora", actingInstructions, version = 1 } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.hume.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  try {
    const response = await proxyFetch("https://api.hume.ai/v0/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hume-Api-Key": apiKey,
      },
      json: {
        utterances: [
          {
            text,
            voice: { name: voice },
            ...(actingInstructions ? { description: actingInstructions } : {}),
          },
        ],
        version,
        format: { type: "mp3" },
        num_generations: 1,
      },
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

    const result = await response
      .json<{
        generations?: Array<{
          audio?: string
          encoding?: { format?: string }
        }>
      }>()
      .catch(() => null)
    const generation = result?.generations?.[0]
    const audioBase64 = generation?.audio
    const formatType = generation?.encoding?.format ?? "mp3"

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return {
        success: false,
        error: getTTSError("api-error", "No audio returned by Hume API").message,
      }
    }

    const bytes = base64ToBytes(audioBase64)
    return {
      success: true,
      audioData: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
      mimeType:
        formatType === "wav" ? "audio/wav" : formatType === "pcm" ? "audio/pcm" : "audio/mpeg",
    }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : "Unknown error")
        .message,
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
