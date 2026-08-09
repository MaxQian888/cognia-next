import { ttsFailure, type BufferedTTSResponseFormat, type TTSResponse } from "./types"

const FORMAT_MIME: Record<BufferedTTSResponseFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
}

export function mimeForBufferedFormat(format: BufferedTTSResponseFormat): string {
  return FORMAT_MIME[format]
}

/** Normalize provider Content-Type without preserving codec/charset parameters. */
export function normalizeAudioMime(
  contentType: string | null | undefined,
  fallbackFormat: BufferedTTSResponseFormat
): TTSResponse | { success: true; mimeType: string } {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime === "audio/pcm" || mime === "audio/l16" || mime === "audio/raw") {
    return ttsFailure("not-supported", {
      providerMessage: "Headerless PCM is not supported by buffered TTS playback",
    })
  }
  if (mime?.startsWith("audio/")) return { success: true, mimeType: mime }
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return { success: true, mimeType: mimeForBufferedFormat(fallbackFormat) }
  }
  return ttsFailure("not-supported", {
    providerMessage: `Unexpected TTS response content type: ${mime}`,
  })
}
