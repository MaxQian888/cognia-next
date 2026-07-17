/**
 * Gemini 2.5 native TTS provider. Returns base64 PCM that we wrap in a
 * minimal WAV header so the HTML <audio> element can play it. Ported from
 * `D:\Project\Cognia\lib\ai\tts\providers\gemini-tts.ts`.
 */

import { proxyFetch } from "../proxy-fetch"
import { ttsFailure, TTS_PROVIDERS, type GeminiTTSVoice, type TTSResponse } from "../types"

const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts"
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

export interface GeminiTTSOptions {
  apiKey: string
  voice?: GeminiTTSVoice
  model?: string
}

export async function generateGeminiTTS(
  text: string,
  options: GeminiTTSOptions
): Promise<TTSResponse> {
  const { apiKey, voice = "Kore", model = GEMINI_TTS_MODEL } = options

  if (!apiKey) {
    return ttsFailure("api-key-missing")
  }
  const max = TTS_PROVIDERS.gemini.maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
  }

  try {
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`
    const response = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      json: {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      },
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

    const result = await response.json<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string }
          }>
        }
      }>
    }>()

    const inline = result.candidates?.[0]?.content?.parts?.[0]?.inlineData
    const audioBase64 = inline?.data
    const mimeType = inline?.mimeType
    if (!audioBase64) {
      return ttsFailure("api-error", { providerMessage: "No audio data in response" })
    }

    const bytes = base64ToBytes(audioBase64)
    const isPcm = !mimeType || /audio\/(l16|pcm)/i.test(mimeType)
    const audioData = isPcm
      ? pcmToWav(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          24000,
          1
        )
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)

    return {
      success: true,
      audioData,
      mimeType: isPcm ? "audio/wav" : mimeType,
    }
  } catch (error) {
    return ttsFailure("network-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

export function pcmToWav(pcmData: ArrayBuffer, sampleRate = 24000, channels = 1): ArrayBuffer {
  const bytesPerSample = 2
  const dataLength = pcmData.byteLength
  const headerLength = 44
  const wav = new ArrayBuffer(headerLength + dataLength)
  const view = new DataView(wav)

  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, "WAVE")
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeString(view, 36, "data")
  view.setUint32(40, dataLength, true)

  const target = new Uint8Array(wav, headerLength)
  target.set(new Uint8Array(pcmData))
  return wav
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
