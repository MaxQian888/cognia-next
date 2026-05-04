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

import { generateText, type LanguageModel } from "ai"
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

/**
 * Configuration for any provider-aware LLM client. The `provider` field
 * picks which AI SDK family is loaded; built-ins are anthropic, openai,
 * google, mistral, cohere. Custom OpenAI-compatible endpoints set
 * `provider: "openai"` and pass `baseURL`.
 */
export interface LlmConfig {
  provider: ProviderName | "openai" | "google" | "mistral" | "cohere"
  model: string
  apiKey: string
  baseURL?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
}

/** @deprecated Kept for back-compat with existing call sites. Use {@link LlmConfig}. */
export type AnthropicLlmConfig = LlmConfig

async function buildLanguageModel(config: LlmConfig): Promise<LanguageModel> {
  switch (config.provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const client = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      return client(config.model)
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const client = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      return client(config.model)
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
      const client = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      return client(config.model)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      const client = createMistral({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      return client(config.model)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      const client = createCohere({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      return client(config.model)
    }
    default:
      throw new Error(
        `createLlmClient: unsupported provider "${config.provider}" — supported: anthropic, openai, google, mistral, cohere`
      )
  }
}

/**
 * Build an `LlmClient` that talks to the configured provider via the `ai`
 * SDK. Each provider's underlying client is loaded lazily so the twin
 * worker doesn't pay the cost for SDKs it never uses.
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  // The model handle is built on first use so import failures surface at
  // `complete()` time (where the workbench can show a meaningful error)
  // rather than at module load.
  let modelPromise: Promise<LanguageModel> | null = null
  const getModel = () => {
    if (!modelPromise) modelPromise = buildLanguageModel(config)
    return modelPromise
  }

  return {
    async complete(prompt, options) {
      const model = await getModel()
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
 * Back-compat alias for the original Anthropic-only factory. Prefer
 * {@link createLlmClient} for new code — the underlying implementation is
 * the same.
 */
export const createAnthropicLlmClient = createLlmClient

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
