/**
 * TTS text utilities — chunking, normalization, language detection,
 * per-provider preprocessing, and SSML generation. Ported from
 * `D:\Project\Cognia\lib\ai\tts\tts-text-utils.ts`.
 */

import type { TTSProvider } from "@/lib/tts/types"
import { TTS_PROVIDERS } from "@/lib/tts/types"

export function splitTextForTTS(
  text: string,
  provider: TTSProvider,
  maxChunkSize?: number
): string[] {
  const limit = maxChunkSize ?? TTS_PROVIDERS[provider].maxTextLength
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining.trim())
      break
    }
    const chunk = findBestSplitPoint(remaining, limit)
    chunks.push(chunk.trim())
    remaining = remaining.substring(chunk.length).trim()
  }
  return chunks.filter((c) => c.length > 0)
}

function findBestSplitPoint(text: string, maxLength: number): string {
  const search = text.substring(0, maxLength)

  let bestIndex = -1
  for (const ender of [". ", "! ", "? ", "。", "！", "？"]) {
    const i = search.lastIndexOf(ender)
    if (i > bestIndex) bestIndex = i + ender.length
  }
  if (bestIndex > maxLength * 0.5) return text.substring(0, bestIndex)

  for (const ender of ["; ", ": ", ", ", "；", "：", "，"]) {
    const i = search.lastIndexOf(ender)
    if (i > bestIndex) bestIndex = i + ender.length
  }
  if (bestIndex > maxLength * 0.3) return text.substring(0, bestIndex)

  const lastSpace = search.lastIndexOf(" ")
  if (lastSpace > 0) return text.substring(0, lastSpace)

  return text.substring(0, maxLength)
}

export function normalizeTextForTTS(text: string): string {
  let out = text.replace(/\s+/g, " ")

  const abbreviations: Record<string, string> = {
    "Mr.": "Mister",
    "Mrs.": "Misses",
    "Ms.": "Miss",
    "Dr.": "Doctor",
    "Prof.": "Professor",
    "Jr.": "Junior",
    "Sr.": "Senior",
    "vs.": "versus",
    "etc.": "etcetera",
    "e.g.": "for example",
    "i.e.": "that is",
  }
  for (const [abbr, full] of Object.entries(abbreviations)) {
    out = out.replace(new RegExp(escapeRegExp(abbr), "gi"), full)
  }

  out = out
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/#/g, " number ")
    .replace(/%/g, " percent ")
    .replace(/\+/g, " plus ")
    .replace(/=/g, " equals ")
    .replace(/\*/g, "")
    .replace(/_/g, " ")

  out = out
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  out = out.replace(/https?:\/\/\S+/g, "")
  out = out.replace(/```[\s\S]*?```/g, "")
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  out = out
    .replace(/\.{3,}/g, "...")
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")

  return out.trim().replace(/\s+/g, " ")
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function estimateSpeechDuration(text: string, rate = 1.0): number {
  const words = text.split(/\s+/).length
  const baseWPM = 150
  return (words / (baseWPM * rate)) * 60
}

export function getWordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

export function isCJKText(text: string): boolean {
  const cjk = /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/g
  const matches = text.match(cjk) || []
  return matches.length > text.length * 0.3
}

export function detectLanguage(text: string): string {
  if (/[一-鿿]/.test(text)) {
    if (/[㄀-ㄯㆠ-ㆿ]/.test(text)) return "zh-TW"
    return "zh-CN"
  }
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja-JP"
  if (/[가-힯]/.test(text)) return "ko-KR"
  if (/[äöüß]/i.test(text)) return "de-DE"
  if (/[éèêëàâùûç]/i.test(text)) return "fr-FR"
  if (/[ñ¿¡]/i.test(text)) return "es-ES"
  return "en-US"
}

export function preprocessTextForProvider(text: string, provider: TTSProvider): string {
  let processed = normalizeTextForTTS(text)
  switch (provider) {
    case "system":
    case "openai":
    case "elevenlabs":
    case "lmnt":
    case "hume":
    case "deepgram":
      break
    case "gemini":
      processed = processed.replace(/[<>]/g, "")
      break
    case "edge":
      processed = processed
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
      break
    case "cartesia":
      processed = processed.replace(/[<>]/g, "")
      break
  }
  return processed
}

export function generateSSML(
  text: string,
  options: {
    voice?: string
    rate?: number
    pitch?: number
    volume?: number
    language?: string
  } = {}
): string {
  const { voice, rate = 1.0, pitch = 1.0, volume = 1.0, language = "en-US" } = options
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
  const rateStr = `${Math.round((rate - 1) * 100)}%`
  const pitchStr = `${Math.round((pitch - 1) * 50)}Hz`
  const volumeStr = `${Math.round((volume - 1) * 100)}%`
  const inner = `<prosody rate="${rateStr}" pitch="${pitchStr}" volume="${volumeStr}">${escaped}</prosody>`
  const wrapped = voice ? `<voice name="${voice}">${inner}</voice>` : inner
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">${wrapped}</speak>`
}
