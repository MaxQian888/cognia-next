/**
 * LLM client abstraction for the distill sub-agents.
 *
 * Each sub-agent (Style / Playbook / Knowledge / Synthesizer / Evaluator)
 * needs to ask Claude (or compatible) for structured JSON output. This
 * module wraps that into a single `LlmClient` interface so:
 *
 *   1. Tests inject deterministic mocks without touching the network.
 *   2. The orchestrator never sees provider-specific SDK calls.
 *   3. Future swap-in of `generateObject` from `ai` is one file's worth of
 *      change — current callers keep their contract.
 *
 * Phase 5 only ships the contract + a JSON-mode helper. Wiring it to a
 * real provider lives behind a default factory so the workbench can pass
 * its own configured client.
 */

import { generateText } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { ProviderName } from "@/types/provider/provider"

export interface LlmClientCallOptions {
  /** System / role-priming prompt. Defaults to a generic distiller voice. */
  system?: string
  /** Maximum tokens in the response. */
  maxTokens?: number
  /** Sampling temperature. Defaults to 0 for distill calls. */
  temperature?: number
  /** Stop sequences passed verbatim to the provider. */
  stopSequences?: string[]
}

export interface LlmClient {
  /**
   * Ask the LLM with a free-form prompt; return the raw text response.
   * The agent layer is responsible for parsing JSON out of the response —
   * doing the parse here would force the same JSON-extract logic on every
   * caller.
   */
  complete(prompt: string, options?: LlmClientCallOptions): Promise<string>
}

export interface AnthropicLlmConfig {
  provider: ProviderName
  model: string
  apiKey: string
  baseURL?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
}

/**
 * Build an `LlmClient` that talks to Anthropic's Messages API via the
 * `ai` SDK. The workbench passes in a config built from user settings.
 */
export function createAnthropicLlmClient(config: AnthropicLlmConfig): LlmClient {
  if (config.provider !== "anthropic") {
    throw new Error(
      `createAnthropicLlmClient: provider must be "anthropic" (got ${config.provider})`
    )
  }
  const anthropic = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  })
  const model = anthropic(config.model)

  return {
    async complete(prompt, options) {
      const result = await generateText({
        model,
        system: options?.system,
        prompt,
        temperature: options?.temperature ?? config.defaultTemperature ?? 0,
        stopSequences: options?.stopSequences,
      })
      return result.text
    },
  }
}

/**
 * Extract the first JSON value out of an LLM response. Tolerates leading
 * prose, fenced ``` blocks, and trailing commentary — common when the
 * model is asked for "JSON only" but slips in a sentence either side.
 *
 * Throws when no parseable JSON is found so callers can surface a clear
 * "LLM returned non-JSON" error to the workbench instead of swallowing
 * the failure silently.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim()
  // Try fenced block first.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    return JSON.parse(fenced[1]) as T
  }
  // Find the first balanced { … } or [ … ] span.
  const start = trimmed.search(/[{[]/)
  if (start === -1) {
    throw new Error(`extractJson: no JSON object or array found in response`)
  }
  // Walk forward respecting nested brackets so we don't trip on stray
  // braces inside string literals. Best-effort but plenty for distill
  // output.
  const opener = trimmed[start]
  const closer = opener === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1)) as T
      }
    }
  }
  throw new Error("extractJson: unterminated JSON span in response")
}
