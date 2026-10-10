import { Tiktoken } from "js-tiktoken/lite"
import cl100kBase from "js-tiktoken/ranks/cl100k_base"
import { estimateCJKTokenCount } from "@cognia/rag/cjk-tokenizer"

const encoder = new Tiktoken(cl100kBase)
const MAX_EXACT_INPUT_CHARS = 32_768
// cl100k merges letter, punctuation and whitespace pieces independently. Its
// JS byte-pair merger is quadratic on a long piece, even in a small document.
const LONG_TOKENIZER_PIECE_RE = /\p{L}{257}|[^\s\p{L}\p{N}]{257}|\s{257}/u

/** Shared renderer fallback used only when a provider has not reported usage. */
export function estimateFallbackTokens(text: string | null | undefined): number {
  if (!text) return 0
  if (text.length > MAX_EXACT_INPUT_CHARS || LONG_TOKENIZER_PIECE_RE.test(text)) {
    // This synchronous renderer estimate must have bounded work. Reuse the
    // existing multilingual heuristic rather than tokenizing an entire upload.
    return Math.max(1, estimateCJKTokenCount(text))
  }
  return encoder.encode(text).length
}

/** Provider usage is authoritative; tokenize only when it is absent or invalid. */
export function resolveTokenCount(
  text: string | null | undefined,
  providerReportedTokens?: number | null
): number {
  return typeof providerReportedTokens === "number" &&
    Number.isFinite(providerReportedTokens) &&
    providerReportedTokens >= 0
    ? providerReportedTokens
    : estimateFallbackTokens(text)
}
