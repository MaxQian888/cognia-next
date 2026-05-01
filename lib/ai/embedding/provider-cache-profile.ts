/**
 * Provider Cache Profile - Maps AI providers to their KV cache / prefix caching capabilities
 *
 * Used by the compression system to make cache-aware decisions:
 * - Providers with prefix caching benefit from stable message prefixes (avoid re-summarizing)
 * - Providers with token discounts for cached prefixes should minimize prefix invalidation
 * - Local inference engines (vLLM, SGLang, ollama) benefit most from prefix stability
 */

import type { ProviderCacheProfile } from "@/types/system/compression"
import type { ProviderName } from "@/types/provider"

/**
 * Provider cache profiles keyed by ProviderName
 *
 * Cache categories:
 * - 'auto': Provider automatically caches matching prefixes (OpenAI, Google)
 * - 'manual': Provider requires explicit cache_control breakpoints (Anthropic)
 * - 'none': No known prefix caching support
 *
 * Prefix stability importance:
 * - 'critical': Local inference with GPU KV cache (vLLM, SGLang, ollama) — cache miss = full re-prefill
 * - 'high': Cloud APIs with significant cached token discounts (OpenAI 50%, Anthropic 90%)
 * - 'low': No caching or negligible benefit — aggressive compression is fine
 */
const PROVIDER_CACHE_PROFILES: Partial<Record<ProviderName, ProviderCacheProfile>> = {
  // === Cloud providers with prefix caching ===
  openai: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 0.5, // 50% off for cached prompt tokens
    requiresCacheControl: false,
    prefixStabilityImportance: "high",
  },
  anthropic: {
    supportsPrefixCache: true,
    cacheType: "manual",
    cachedTokenDiscount: 0.9, // 90% off for cached tokens (but write cost exists)
    requiresCacheControl: true,
    prefixStabilityImportance: "high",
  },
  google: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 0.5,
    requiresCacheControl: false,
    prefixStabilityImportance: "high",
  },

  // === Cloud providers without known prefix caching ===
  deepseek: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  groq: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  mistral: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  xai: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  togetherai: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  openrouter: {
    // OpenRouter routes to various backends — some may have caching, conservative default
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  cohere: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  fireworks: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  cerebras: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
  sambanova: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },

  // === Local inference engines — GPU KV cache reuse is critical ===
  vllm: {
    supportsPrefixCache: true,
    cacheType: "auto", // vLLM Automatic Prefix Caching (APC)
    cachedTokenDiscount: 1.0, // No cost, but saves GPU compute time
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  ollama: {
    supportsPrefixCache: true,
    cacheType: "auto", // ollama keeps KV cache between requests with same prefix
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  lmstudio: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  llamacpp: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  llamafile: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  localai: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  jan: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  textgenwebui: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  koboldcpp: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },
  tabbyapi: {
    supportsPrefixCache: true,
    cacheType: "auto",
    cachedTokenDiscount: 1.0,
    requiresCacheControl: false,
    prefixStabilityImportance: "critical",
  },

  // === Proxy/Aggregator ===
  cliproxyapi: {
    supportsPrefixCache: false,
    cacheType: "none",
    cachedTokenDiscount: 0,
    requiresCacheControl: false,
    prefixStabilityImportance: "low",
  },
}

/** Default profile for unknown or 'auto' providers */
const DEFAULT_CACHE_PROFILE: ProviderCacheProfile = {
  supportsPrefixCache: false,
  cacheType: "none",
  cachedTokenDiscount: 0,
  requiresCacheControl: false,
  prefixStabilityImportance: "low",
}

/**
 * Get the cache profile for a provider
 */
export function getProviderCacheProfile(provider: ProviderName): ProviderCacheProfile {
  if (provider === "auto") return DEFAULT_CACHE_PROFILE
  return PROVIDER_CACHE_PROFILES[provider] ?? DEFAULT_CACHE_PROFILE
}

/**
 * Check if a provider should prioritize prefix stability over aggressive compression
 * Returns true for providers where prefix cache invalidation is costly
 */
export function shouldPrioritizePrefixStability(provider: ProviderName): boolean {
  const profile = getProviderCacheProfile(provider)
  return (
    profile.prefixStabilityImportance === "critical" || profile.prefixStabilityImportance === "high"
  )
}

/**
 * Check if a provider uses local inference (GPU KV cache)
 */
export function isLocalInferenceProvider(provider: ProviderName): boolean {
  const profile = getProviderCacheProfile(provider)
  return profile.prefixStabilityImportance === "critical"
}

/**
 * Get all provider names that support prefix caching
 */
export function getProvidersWithPrefixCache(): ProviderName[] {
  return (Object.entries(PROVIDER_CACHE_PROFILES) as [ProviderName, ProviderCacheProfile][])
    .filter(([, profile]) => profile.supportsPrefixCache)
    .map(([name]) => name)
}
