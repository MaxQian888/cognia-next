/**
 * Xiaomi MiMo TTS — style-tag-enabled voice synthesis via the
 * `/v1/chat/completions` endpoint. Returns base64-encoded WAV inside a
 * JSON envelope, similar to the Hume and Gemini providers.
 *
 * API docs: https://platform.xiaomimimo.com/docs/usage-guide/speech-synthesis-v2.5
 */

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import {
  getTTSError,
  TTS_PROVIDERS,
  XIAOMI_TTS_STYLES,
  type TTSResponse,
  type XiaomiTTSModel,
  type XiaomiTTSStyle,
  type XiaomiTTSVoice,
} from "@/types/media/tts"

const XIAOMI_TTS_URL = "https://api.xiaomimimo.com/v1/chat/completions"

export interface XiaomiTTSOptions {
  apiKey: string
  voice?: XiaomiTTSVoice
  model?: XiaomiTTSModel
  style?: XiaomiTTSStyle | ""
  dialect?: string
}

export async function generateXiaomiTTS(
  text: string,
  options: XiaomiTTSOptions
): Promise<TTSResponse> {
  const { apiKey, voice = "mimo_default", model = "mimo-v2-tts", style, dialect } = options

  if (!apiKey) {
    return { success: false, error: getTTSError("api-key-missing").message }
  }
  const max = TTS_PROVIDERS.xiaomi.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  // Build the style hint for the user message.
  const styleParts: string[] = []
  if (style) {
    const styleDef = XIAOMI_TTS_STYLES.find((s) => s.id === style)
    styleParts.push(styleDef?.tag ?? `[${style}]`)
  }
  if (dialect) {
    styleParts.push(`[${dialect}]`)
  }
  const styleHint = styleParts.length > 0 ? styleParts.join("") + " " : ""

  const messages: Array<{ role: string; content: string }> = []
  if (styleHint) {
    messages.push({ role: "user", content: `${styleHint}请按此风格朗读` })
  }
  messages.push({ role: "assistant", content: text })

  try {
    const response = await proxyFetch(XIAOMI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      json: {
        model,
        messages,
        audio: {
          format: "wav",
          voice,
        },
      },
    })

    if (!response.ok) {
      const err = await response
        .json<{ error?: { message?: string } }>()
        .catch(() => ({}) as { error?: { message?: string } })
      return {
        success: false,
        error: getTTSError("api-error", err.error?.message ?? `API error: ${response.status}`)
          .message,
      }
    }

    const result = await response
      .json<{
        choices?: Array<{
          message?: {
            audio?: {
              data?: string
            }
          }
        }>
      }>()
      .catch(() => null)

    const audioBase64 = result?.choices?.[0]?.message?.audio?.data

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return {
        success: false,
        error: getTTSError("api-error", "No audio returned by Xiaomi MiMo API").message,
      }
    }

    const bytes = base64ToBytes(audioBase64)
    return {
      success: true,
      audioData: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
      mimeType: "audio/wav",
    }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("network-error", error instanceof Error ? error.message : "Unknown error")
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
