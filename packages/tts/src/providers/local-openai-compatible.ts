import { normalizeAudioMime } from "../audio-response"
import { proxyFetch } from "../proxy-fetch"
import {
  TTS_PROVIDERS,
  ttsFailure,
  type BufferedTTSResponseFormat,
  type TTSResponse,
} from "../types"

export interface LocalOpenAICompatibleTTSOptions {
  baseUrl: string
  model: string
  voice: string
  speed?: number
  responseFormat?: BufferedTTSResponseFormat
  timeoutMs?: number
  apiKey?: string
  signal?: AbortSignal
  requestId?: string
}

function speechUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  return normalized.endsWith("/audio/speech") ? normalized : `${normalized}/audio/speech`
}

function isAllowedLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.hostname.toLowerCase() === "localhost") return true
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(url.hostname)
    if (ipv4) {
      return ipv4.slice(1).every((part) => Number(part) <= 255) && Number(ipv4[1]) === 127
    }
    return url.hostname === "[::1]" || url.hostname === "::1"
  } catch {
    return false
  }
}

export async function generateLocalOpenAICompatibleTTS(
  text: string,
  options: LocalOpenAICompatibleTTSOptions
): Promise<TTSResponse> {
  const baseUrl = options.baseUrl.trim()
  const model = options.model.trim()
  const voice = options.voice.trim()
  if (!baseUrl || !model || !voice) {
    return ttsFailure("not-supported", {
      providerMessage: "Configure the local endpoint, model, and voice before synthesis",
    })
  }
  if (!isAllowedLoopbackBaseUrl(baseUrl)) {
    return ttsFailure("not-supported", {
      providerMessage: "Local TTS endpoints must use HTTP or HTTPS on a loopback address",
    })
  }
  const max = TTS_PROVIDERS["local-openai-compatible"].maxTextLength
  if (text.length > max) {
    return ttsFailure("text-too-long", { providerMessage: `Maximum ${max} characters` })
  }

  const responseFormat = options.responseFormat ?? "mp3"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.apiKey?.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`

  try {
    const response = await proxyFetch(speechUrl(baseUrl), {
      method: "POST",
      provider: "local-openai-compatible",
      headers,
      json: {
        model,
        input: text,
        voice,
        speed: Math.min(4, Math.max(0.25, options.speed ?? 1)),
        response_format: responseFormat,
      },
      signal: options.signal,
      requestId: options.requestId,
      timeoutMs: options.timeoutMs ?? 60_000,
    })
    if (!response.ok) {
      const providerMessage = await response
        .json<{ error?: { message?: string }; detail?: string }>()
        .then((body) => body.error?.message ?? body.detail)
        .catch(() => undefined)
      return ttsFailure("api-error", {
        status: response.status,
        providerMessage: providerMessage ?? `API error: ${response.status}`,
      })
    }
    const normalized = normalizeAudioMime(response.mime, responseFormat)
    if (!normalized.success) return normalized
    return { success: true, audioData: response.bytes, mimeType: normalized.mimeType }
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return ttsFailure("cancelled")
    }
    return ttsFailure("network-error", {
      providerMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
