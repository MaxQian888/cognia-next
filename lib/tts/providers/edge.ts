/**
 * Edge-TTS — Microsoft's free neural voice service. The original Cognia
 * provider hits `/api/tts/edge` which opens a WebSocket from a Next.js
 * route. Under static export there is no Next.js server, so cognia-next
 * routes synthesis through the `tts_edge_synthesize` Tauri command (in
 * `src-tauri/src/tts/edge.rs`). On pure-web mode (no Tauri), this provider
 * surfaces a "desktop only" error.
 */

import { isTauri } from "@/lib/tauri"
import { getTTSError, TTS_PROVIDERS, type EdgeTTSVoice, type TTSResponse } from "@/lib/tts/types"

export interface EdgeTTSOptions {
  voice?: EdgeTTSVoice
  rate?: string
  pitch?: string
  volume?: string
}

interface EdgeTauriResponse {
  body_b64: string
  mime: string
}

export async function generateEdgeTTS(
  text: string,
  options: EdgeTTSOptions = {}
): Promise<TTSResponse> {
  const { voice = "en-US-JennyNeural", rate = "+0%", pitch = "+0Hz", volume = "+0%" } = options

  const max = TTS_PROVIDERS.edge.maxTextLength
  if (text.length > max) {
    return {
      success: false,
      error: getTTSError("text-too-long", `Maximum ${max} characters`).message,
    }
  }

  if (!isTauri()) {
    return {
      success: false,
      error: "Edge TTS requires the desktop app (it tunnels through a Tauri-side WebSocket).",
    }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const response = await invoke<EdgeTauriResponse>("tts_edge_synthesize", {
      request: { text, voice, rate, pitch, volume },
    })
    const bytes = base64ToBytes(response.body_b64)
    return {
      success: true,
      audioData: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
      mimeType: response.mime || "audio/mpeg",
    }
  } catch (error) {
    return {
      success: false,
      error: getTTSError("api-error", error instanceof Error ? error.message : String(error))
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
