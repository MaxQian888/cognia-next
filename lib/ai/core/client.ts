/**
 * Cognia-style AI client surface. cognia-next's authoritative provider
 * type lives in `@/types/provider/provider`; this module re-exports it
 * and provides `getProviderModel()` that the ported canvas-actions code
 * uses to obtain a Vercel AI SDK `LanguageModelV1`.
 */

import { anthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import type { ProviderName } from "@/types/provider/provider"

export type { ProviderName } from "@/types/provider/provider"

export interface ProviderModelOptions {
  provider: ProviderName
  model: string
  apiKey?: string
  baseURL?: string
}

/**
 * Resolve a Vercel AI SDK model handle for a given provider+model. We
 * only fully support Anthropic in cognia-next today (its single sidecar
 * model) — other providers fall back to the Anthropic client so we
 * still produce a runnable model rather than throwing. Replace when a
 * multi-provider matrix lands.
 */
export function getProviderModel(opts: ProviderModelOptions): LanguageModel {
  if (opts.apiKey) {
    if (typeof process !== "undefined") {
      process.env = process.env ?? {}
      process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? opts.apiKey
    }
  }
  return anthropic(opts.model || "claude-sonnet-4-5") as LanguageModel
}
