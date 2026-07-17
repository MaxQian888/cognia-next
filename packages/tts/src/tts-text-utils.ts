/**
 * TTS text utilities — chunking, normalization, language detection,
 * per-provider preprocessing, and SSML generation. Ported from
 * `D:\Project\Cognia\lib\ai\tts\tts-text-utils.ts`.
 */

import type { TTSProvider } from "./types"
import { TTS_PROVIDERS } from "./types"

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
  // Order is load-bearing. Structure must be stripped BEFORE whitespace is
  // collapsed (the /gm line anchors only work while newlines survive) and
  // BEFORE the symbol pass (which deletes bare `*` that emphasis rules need).
  //
  // ① Strip block/inline structure while newlines still exist.
  let out = text
    // Fenced code blocks first — otherwise the inline-code rule below eats the
    // ``` fences pairwise and leaves the code body to be read aloud.
    .replace(/```[\s\S]*?```/g, "")
    // Inline code — unwrap, keep the content.
    .replace(/`(.*?)`/g, "$1")
    // Headings and list markers — line-anchored, need the newlines intact.
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // Emphasis — before the symbol pass strips bare `*`, so bold/italic are
    // actually unwrapped instead of being dead rules.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    // Markdown links — keep the label; before the bare-URL rule so it doesn't
    // swallow the closing paren first.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Bare URLs — dropped (semantics lost; expansion is a separate gap).
    .replace(/https?:\/\/\S+/g, "")
    // Smart quotes → ASCII.
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")

  // ② Collapse whitespace now that newlines have done their structural job.
  out = out.replace(/\s+/g, " ")

  // ③ Expand abbreviations, then symbol → word substitutions.
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
  // Kana and hangul are checked BEFORE han/kanji: most Japanese (and some
  // Korean) text also contains kanji/hanja, so a han-first test would misroute
  // nearly all Japanese to Chinese. The old zh-TW branch keyed on bopomofo,
  // which almost never appears in real prose — a dead branch, now dropped.
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja-JP"
  if (/[가-힯]/.test(text)) return "ko-KR"
  if (/[一-鿿]/.test(text)) return "zh-CN"
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
    case "xiaomi":
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

/**
 * Replace words in `text` according to a pronunciation dictionary.
 * Keys are matched case-insensitively as whole words.
 */
export function applyPronunciationDictionary(
  text: string,
  dictionary: Record<string, string>
): string {
  // Use placeholder substitution to prevent chain replacements where a
  // replacement from one entry is re-matched by a later entry.
  const placeholders = new Map<string, string>()
  let result = text
  let i = 0
  for (const [word, replacement] of Object.entries(dictionary)) {
    if (!word) continue
    const placeholder = `__PD_${i}__`
    placeholders.set(placeholder, replacement)
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "gi"), placeholder)
    i++
  }
  for (const [placeholder, replacement] of placeholders) {
    result = result.replace(new RegExp(placeholder, "g"), replacement)
  }
  return result
}
