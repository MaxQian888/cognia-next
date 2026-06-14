/**
 * Token Usage types and utilities
 *
 * Unified token usage tracking across the application.
 * Field naming follows AI SDK convention (inputTokens/outputTokens)
 * with aliases for backward compatibility (prompt/completion).
 */

import { getBuiltInProviderCatalogEntry } from "@/types/provider/built-in-provider-catalog"

export interface TokenUsage {
  /** Input/prompt tokens */
  prompt: number
  /** Output/completion tokens */
  completion: number
  /** Total tokens (prompt + completion) */
  total: number
  /** Alias for prompt tokens (AI SDK naming) */
  inputTokens?: number
  /** Alias for completion tokens (AI SDK naming) */
  outputTokens?: number
  /**
   * Reasoning / "thinking" tokens, when the provider reports them separately
   * (OpenAI o-series/gpt-5 via `reasoningTokens`, AI SDK v6 usage). These are
   * a SUBSET of output tokens — already billed at the output rate — surfaced
   * for observability, not added to the cost again. `undefined` when the
   * provider doesn't break them out (e.g. native Anthropic bundles thinking
   * into output_tokens).
   */
  reasoningTokens?: number
}

/** Request status for tracking success/error states */
export type UsageRecordStatus = "success" | "error" | "timeout" | "cancelled"

export interface UsageRecord {
  id: string
  sessionId: string
  messageId: string
  provider: string
  model: string
  tokens: TokenUsage
  cost: number
  createdAt: Date
  /** Response latency in milliseconds */
  latency?: number
  /** Request status for error tracking */
  status?: UsageRecordStatus
  /** Error message if status is 'error' */
  errorMessage?: string
  /** Time to first token in milliseconds (streaming) */
  timeToFirstToken?: number
}

export interface DailyUsage {
  date: string
  tokens: number
  cost: number
  requests: number
}

export interface ProviderUsage {
  provider: string
  tokens: number
  cost: number
  requests: number
}

// Model pricing (per 1M tokens, Standard tier) - updated April 2026
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI - GPT-5.4 family (Apr 2026)
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  // OpenAI - GPT-5 family
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.2-pro": { input: 21, output: 168 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // OpenAI - GPT-4.1 family
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  // OpenAI - GPT-4o family
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o-audio-preview": { input: 2.5, output: 10 },
  // OpenAI - GPT-4 legacy
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  // OpenAI - o-series reasoning
  o1: { input: 15, output: 60 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1-pro": { input: 150, output: 600 },
  o3: { input: 2, output: 8 },
  "o3-pro": { input: 20, output: 80 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },

  // Anthropic - Claude 4.6 family (latest)
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6-20260205": { input: 5, output: 25 },
  // Anthropic - Claude 4.5 family
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-sonnet-4-5-20251101": { input: 3, output: 15 },
  // Anthropic - Claude 4.1 family
  "claude-opus-4-1-20250414": { input: 15, output: 75 },
  // Anthropic - Claude 4 family
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  // Anthropic - Claude 3.7
  "claude-3-7-sonnet-20250219": { input: 3, output: 15 },
  // Anthropic - Claude 3.5 family
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  // Anthropic - Claude 3 family
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },

  // Google - Gemini 3.1 (latest preview)
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  "gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.5 },
  // Google - Gemini 3 (preview)
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-3-pro-preview": { input: 2, output: 12 },
  // Google - Gemini 2.5
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // Google - Gemini 2.0 (deprecated Jun 2026)
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-exp": { input: 0, output: 0 },
  // Google - Gemini 1.5
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },

  // DeepSeek
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, output: 0.28 },

  // xAI - Grok
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.3, output: 0.5 },

  // Groq (free tier)
  "llama-3.3-70b-versatile": { input: 0, output: 0 },
  "llama-3.1-70b-versatile": { input: 0, output: 0 },
  "mixtral-8x7b-32768": { input: 0, output: 0 },

  // Mistral
  "mistral-large-latest": { input: 2, output: 6 },
  "mistral-small-latest": { input: 0.2, output: 0.6 },
  "codestral-latest": { input: 0.2, output: 0.6 },

  // OpenRouter / Meta (common via OpenRouter)
  "meta-llama/llama-3.3-70b-instruct": { input: 0.39, output: 0.39 },
  "meta-llama/llama-4-maverick": { input: 0.2, output: 0.6 },

  // Ollama (local, free)
  "llama3.2": { input: 0, output: 0 },
  "llama3.1": { input: 0, output: 0 },
  mistral: { input: 0, output: 0 },
  mixtral: { input: 0, output: 0 },
  "qwen2.5": { input: 0, output: 0 },
  qwen3: { input: 0, output: 0 },
  "deepseek-r1": { input: 0, output: 0 },
  "phi-4": { input: 0, output: 0 },
  gemma3: { input: 0, output: 0 },
}

/**
 * Chinese provider pricing in CNY (per 1M tokens)
 * These are native CNY prices, not converted from USD
 * Used when the provider bills in CNY directly
 * Updated February 2026 — sources: SiliconFlow, official provider pages, 36Kr
 */
export const MODEL_PRICING_CNY: Record<string, { input: number; output: number }> = {
  // DeepSeek — official API (updated April 2026)
  "deepseek-v4-flash": { input: 1, output: 2 },
  "deepseek-v4-pro": { input: 12.5, output: 25 },
  "deepseek-chat": { input: 1, output: 2 },
  "deepseek-reasoner": { input: 1, output: 2 },
  "deepseek-v3.2": { input: 2, output: 3 },
  "deepseek-v3.1": { input: 4, output: 12 },

  // Zhipu AI / GLM (智谱 - per 1M tokens, Feb 2026)
  "glm-4.7": { input: 4, output: 16 },
  "glm-4.6": { input: 3.5, output: 14 },
  "glm-4.6v": { input: 1, output: 3 },
  "glm-4.5v": { input: 1, output: 6 },
  "glm-4.5-air": { input: 1, output: 6 },
  "glm-z1-32b": { input: 1, output: 4 },
  "glm-z1-rumination-32b": { input: 1, output: 4 },
  "glm-4-32b": { input: 1.89, output: 1.89 },
  "glm-4-plus": { input: 50, output: 50 },
  "glm-4-long": { input: 1, output: 1 },
  "glm-4-flash": { input: 0, output: 0 },
  "glm-4v-plus": { input: 10, output: 10 },

  // Qwen / Tongyi (通义千问 - per 1M tokens, Feb 2026)
  "qwen3-coder-480b-a35b": { input: 8, output: 16 },
  "qwen3-next-80b-a3b": { input: 1, output: 4 },
  "qwen3-235b-a22b": { input: 2.5, output: 10 },
  "qwen3-32b": { input: 1, output: 4 },
  "qwen3-30b-a3b": { input: 0.7, output: 2.8 },
  "qwen3-14b": { input: 0.5, output: 2 },
  "qwen3-8b": { input: 0, output: 0 },
  "qwen3-coder-30b-a3b": { input: 0.7, output: 2.8 },
  "qwen3-vl-235b-a22b": { input: 2.5, output: 10 },
  "qwen3-vl-32b": { input: 1, output: 4 },
  "qwen3-vl-8b": { input: 0.5, output: 2 },
  "qwen3-omni-30b-a3b": { input: 0.7, output: 2.8 },
  "qwq-32b": { input: 1, output: 4 },
  "qwen-max": { input: 20, output: 60 },
  "qwen-plus": { input: 0.8, output: 2 },
  "qwen-turbo": { input: 0.3, output: 0.6 },
  "qwen-long": { input: 0.5, output: 2 },
  "qwen-vl-max": { input: 20, output: 60 },
  "qwen-vl-plus": { input: 8, output: 20 },

  // Moonshot / Kimi (月之暗面 - per 1M tokens, Feb 2026)
  "kimi-k2.5": { input: 4, output: 21 },
  "kimi-k2": { input: 4, output: 16 },
  "kimi-dev-72b": { input: 2, output: 8 },
  "moonshot-v1-8k": { input: 12, output: 12 },
  "moonshot-v1-32k": { input: 24, output: 24 },
  "moonshot-v1-128k": { input: 60, output: 60 },

  // Baichuan (百川 - per 1M tokens)
  Baichuan4: { input: 100, output: 100 },
  "Baichuan3-Turbo": { input: 12, output: 12 },
  "Baichuan3-Turbo-128k": { input: 24, output: 24 },

  // MiniMax (per 1M tokens, Apr 2026)
  "MiniMax-M2.7": { input: 0.3, output: 1.2 },
  "MiniMax-M2.7-highspeed": { input: 0.3, output: 1.2 },
  "MiniMax-M2.5": { input: 0.15, output: 1.2 },
  "MiniMax-M2.5-highspeed": { input: 0.3, output: 2.4 },
  "MiniMax-M2.1": { input: 0.27, output: 0.95 },
  "MiniMax-M2.1-highspeed": { input: 0.27, output: 0.95 },
  "MiniMax-M2": { input: 0.255, output: 1.0 },

  // StepFun / 阶跃星辰 (per 1M tokens, Feb 2026)
  step3: { input: 4, output: 10 },

  // ByteDance / 字节跳动 - 豆包 Doubao (per 1M tokens, Feb 2026)
  "doubao-1.5-pro": { input: 2, output: 9 },
  "seed-oss-36b": { input: 1.5, output: 4 },

  // Baidu / 百度 - 文心 ERNIE (per 1M tokens, Feb 2026)
  "ernie-4.5-300b": { input: 2, output: 8 },
  "ernie-x1": { input: 0.004, output: 0.016 },

  // Tencent / 腾讯 - 混元 Hunyuan (per 1M tokens, Feb 2026)
  "hunyuan-a13b": { input: 1, output: 4 },
  "hunyuan-mt-7b": { input: 0, output: 0 },

  // InclusionAI / 影刀 - 灵 Ling (per 1M tokens, Feb 2026)
  "ling-flash-2.0": { input: 1, output: 4 },
  "ling-mini-2.0": { input: 0.5, output: 2 },

  // SiliconFlow platform routing (per 1M tokens, Feb 2026)
  "deepseek-ai/DeepSeek-V3": { input: 2, output: 8 },
  "deepseek-ai/DeepSeek-V3.2": { input: 2, output: 3 },
  "deepseek-ai/DeepSeek-R1": { input: 4, output: 16 },
  "Qwen/Qwen3-235B-A22B": { input: 2.5, output: 10 },
  "Qwen/Qwen3-32B": { input: 1, output: 4 },
  "Qwen/QwQ-32B": { input: 1, output: 4 },
  "THUDM/GLM-4-32B-0414": { input: 1.89, output: 1.89 },
  "THUDM/GLM-Z1-32B-0414": { input: 1, output: 4 },
  "moonshotai/Kimi-K2-Instruct-0905": { input: 4, output: 16 },
  "moonshotai/Kimi-K2-Thinking": { input: 4, output: 16 },
  "MiniMaxAI/MiniMax-M2": { input: 0.255, output: 1.0 },
  "MiniMaxAI/MiniMax-M2.1": { input: 0.27, output: 0.95 },
  "MiniMaxAI/MiniMax-M2.5": { input: 0.15, output: 1.2 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2 },
}

/**
 * Get pricing for a model, checking USD table, CNY table, and finally the
 * built-in provider catalog when a `providerId` is supplied. The catalog
 * fallback is what gives OpenCode Zen / Go specific models (e.g. `kimi-k2.6`,
 * `glm-5.1`) a price even when they are absent from the global tables.
 */
export function getModelPricingUSD(
  model: string,
  providerId?: string
): { input: number; output: number } | null {
  const usdPricing = MODEL_PRICING[model]
  if (usdPricing) return usdPricing

  const cnyPricing = MODEL_PRICING_CNY[model]
  if (cnyPricing) {
    const rate = CURRENCIES.CNY.rateFromUSD
    return {
      input: cnyPricing.input / rate,
      output: cnyPricing.output / rate,
    }
  }

  if (providerId) {
    const entry = getBuiltInProviderCatalogEntry(providerId)?.models?.find((m) => m.id === model)
    const pricing = entry?.pricing
    if (pricing) {
      const rate =
        pricing.currency === "CNY" ? CURRENCIES.CNY.rateFromUSD : CURRENCIES.USD.rateFromUSD
      return {
        input: pricing.promptPer1M / rate,
        output: pricing.completionPer1M / rate,
      }
    }
  }

  return null
}

/**
 * Calculate cost from token usage
 */
export function calculateCost(model: string, tokens: TokenUsage, providerId?: string): number {
  const pricing = getModelPricingUSD(model, providerId)
  if (!pricing) return 0

  const inputCost = (tokens.prompt / 1_000_000) * pricing.input
  const outputCost = (tokens.completion / 1_000_000) * pricing.output

  return inputCost + outputCost
}

/**
 * Calculate cost from input/output tokens (AI SDK naming convention)
 */
export function calculateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  providerId?: string
): number {
  const pricing = getModelPricingUSD(model, providerId)
  if (!pricing) return 0

  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output

  return inputCost + outputCost
}

/**
 * Normalize token usage to standard format
 */
export function normalizeTokenUsage(usage: {
  prompt?: number
  completion?: number
  inputTokens?: number
  outputTokens?: number
  total?: number
}): TokenUsage {
  const prompt = usage.prompt ?? usage.inputTokens ?? 0
  const completion = usage.completion ?? usage.outputTokens ?? 0
  return {
    prompt,
    completion,
    total: usage.total ?? prompt + completion,
    inputTokens: prompt,
    outputTokens: completion,
  }
}

// cognia-next has no `@/lib/observability` module; ship a small inline
// formatter so the cost tab can render token counts.
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(tokens)
}

/**
 * Supported currency codes
 */
export type CurrencyCode = "USD" | "CNY"

/**
 * Currency configuration
 */
export interface CurrencyConfig {
  code: CurrencyCode
  symbol: string
  name: string
  locale: string
  /** Exchange rate relative to USD (1 USD = X units) */
  rateFromUSD: number
  /** Decimal places for display */
  decimals: number
  /** Label for "free" in this locale */
  freeLabel: string
  /** Position of symbol: 'prefix' or 'suffix' */
  symbolPosition: "prefix" | "suffix"
}

/**
 * Supported currencies with exchange rates
 * Rates are approximate and should be updated periodically
 */
export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  USD: {
    code: "USD",
    symbol: "$",
    name: "US Dollar",
    locale: "en",
    rateFromUSD: 1,
    decimals: 2,
    freeLabel: "Free",
    symbolPosition: "prefix",
  },
  CNY: {
    code: "CNY",
    symbol: "¥",
    name: "人民币",
    locale: "zh-CN",
    rateFromUSD: 7.25,
    decimals: 2,
    freeLabel: "免费",
    symbolPosition: "prefix",
  },
}

/**
 * Map language setting to default currency
 */
export const LOCALE_CURRENCY_MAP: Record<string, CurrencyCode> = {
  en: "USD",
  "zh-CN": "CNY",
}

/**
 * Get the default currency for a given language/locale
 */
export function getCurrencyForLocale(locale: string): CurrencyCode {
  return LOCALE_CURRENCY_MAP[locale] || "USD"
}

/**
 * Convert a USD amount to another currency
 */
export function convertCurrency(amountUSD: number, targetCurrency: CurrencyCode): number {
  const config = CURRENCIES[targetCurrency]
  return amountUSD * config.rateFromUSD
}

/**
 * Format cost in a specific currency
 */
export function formatCostInCurrency(costUSD: number, currency: CurrencyCode = "USD"): string {
  const config = CURRENCIES[currency]

  if (costUSD === 0) return config.freeLabel

  const converted = convertCurrency(costUSD, currency)

  if (converted < Math.pow(10, -config.decimals)) {
    return config.symbolPosition === "prefix"
      ? `<${config.symbol}${Math.pow(10, -config.decimals).toFixed(config.decimals)}`
      : `<${Math.pow(10, -config.decimals).toFixed(config.decimals)}${config.symbol}`
  }

  const formatted = converted.toFixed(config.decimals)
  return config.symbolPosition === "prefix"
    ? `${config.symbol}${formatted}`
    : `${formatted}${config.symbol}`
}

/**
 * Format cost (backward-compatible, USD only)
 */
export function formatCost(cost: number): string {
  return formatCostInCurrency(cost, "USD")
}

/**
 * Format model pricing for display with currency conversion
 * Shows price per 1M tokens in the target currency
 */
export function formatModelPricing(
  modelId: string,
  currency: CurrencyCode = "USD",
  providerId?: string
): { input: string; output: string } | null {
  // For CNY currency, prefer native CNY pricing if available
  if (currency === "CNY") {
    const cnyPricing = MODEL_PRICING_CNY[modelId]
    if (cnyPricing) {
      const config = CURRENCIES.CNY
      const formatValue = (value: number) => {
        if (value === 0) return config.freeLabel
        const formatted = value < 0.01 ? value.toFixed(4) : value.toFixed(config.decimals)
        return `${config.symbol}${formatted}`
      }
      return { input: formatValue(cnyPricing.input), output: formatValue(cnyPricing.output) }
    }
  }

  const pricing = getModelPricingUSD(modelId, providerId)
  if (!pricing) return null

  const config = CURRENCIES[currency]
  const inputConverted = convertCurrency(pricing.input, currency)
  const outputConverted = convertCurrency(pricing.output, currency)

  const formatValue = (value: number) => {
    if (value === 0) return config.freeLabel
    const formatted = value < 0.01 ? value.toFixed(4) : value.toFixed(config.decimals)
    return config.symbolPosition === "prefix"
      ? `${config.symbol}${formatted}`
      : `${formatted}${config.symbol}`
  }

  return {
    input: formatValue(inputConverted),
    output: formatValue(outputConverted),
  }
}

/**
 * Update the exchange rate for a currency
 * Useful for runtime updates from external APIs
 */
export function updateExchangeRate(currency: CurrencyCode, rateFromUSD: number): void {
  if (CURRENCIES[currency]) {
    CURRENCIES[currency].rateFromUSD = rateFromUSD
  }
}
