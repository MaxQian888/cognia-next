import { Tiktoken } from "js-tiktoken/lite"
import cl100kBase from "js-tiktoken/ranks/cl100k_base"

const encoder = new Tiktoken(cl100kBase)

/** Shared renderer fallback used only when a provider has not reported usage. */
export function estimateFallbackTokens(text: string | null | undefined): number {
  if (!text) return 0
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
