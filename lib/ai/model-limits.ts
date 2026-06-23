/**
 * Unified Model Context Limits
 *
 * Single source of truth for model context window sizes and reserve tokens.
 * Extracted from lib/ai/rag/context-manager.ts to eliminate duplication
 * with chat-container.tsx's inline modelTokenLimits.
 */

export interface ModelContextLimits {
  maxTokens: number
  reserveTokens: number
}

const MODEL_CONTEXT_LIMITS: Record<string, ModelContextLimits> = {
  // OpenAI GPT
  "gpt-4": { maxTokens: 8192, reserveTokens: 2000 },
  "gpt-4-32k": { maxTokens: 32768, reserveTokens: 4000 },
  "gpt-4-turbo": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o-mini": { maxTokens: 128000, reserveTokens: 8000 },
  // GPT-5.4 family
  "gpt-5.4": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-mini": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-nano": { maxTokens: 1000000, reserveTokens: 8000 },
  "gpt-5.4-pro": { maxTokens: 1000000, reserveTokens: 10000 },
  // GPT-4.1 family
  "gpt-4.1": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-mini": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-nano": { maxTokens: 1047576, reserveTokens: 8000 },
  "gpt-3.5-turbo": { maxTokens: 16385, reserveTokens: 2000 },
  o1: { maxTokens: 200000, reserveTokens: 10000 },
  o3: { maxTokens: 200000, reserveTokens: 10000 },
  "o4-mini": { maxTokens: 200000, reserveTokens: 10000 },

  // Anthropic Claude — current 1M-context tiers (Opus 4.6+/Sonnet 4.6).
  // Real model ids are longer than the legacy family keys below, so the
  // longest-key-first substring match in getModelContextLimits resolves these
  // before the generic "claude-sonnet" / "claude-4-opus" fallbacks.
  "claude-opus-4-8": { maxTokens: 1000000, reserveTokens: 10000 },
  "claude-opus-4-7": { maxTokens: 1000000, reserveTokens: 10000 },
  "claude-opus-4-6": { maxTokens: 1000000, reserveTokens: 10000 },
  "claude-sonnet-4-6": { maxTokens: 1000000, reserveTokens: 10000 },
  "claude-haiku-4-5": { maxTokens: 200000, reserveTokens: 8000 },
  // Legacy / generic family keys (200k context).
  "claude-3-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-3.5-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3.5-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-4-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-4-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-sonnet": { maxTokens: 200000, reserveTokens: 10000 },

  // Google Gemini
  "gemini-pro": { maxTokens: 32768, reserveTokens: 4000 },
  "gemini-1.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-1.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.0-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  // Gemini 3
  "gemini-3-flash-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-pro-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-flash-lite-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  // Gemini 2.5
  "gemini-2.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash-lite": { maxTokens: 1048576, reserveTokens: 8000 },

  // DeepSeek
  "deepseek-v4-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v4-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v3": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-r1": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-chat": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-reasoner": { maxTokens: 1048576, reserveTokens: 10000 },

  // Qwen
  "qwen-2.5": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-3": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-turbo": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-plus": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-max": { maxTokens: 131072, reserveTokens: 8000 },
}

/**
 * Get context limits for a given model.
 * Uses substring matching with longest-key-first for specificity,
 * then falls back to provider-family heuristics.
 */
export function getModelContextLimits(model: string): ModelContextLimits {
  // Exact match first
  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model]
  }

  // Substring match (longer keys first for specificity)
  const sortedKeys = Object.keys(MODEL_CONTEXT_LIMITS).sort((a, b) => b.length - a.length)
  const modelLower = model.toLowerCase()
  for (const key of sortedKeys) {
    if (modelLower.includes(key)) {
      return MODEL_CONTEXT_LIMITS[key]
    }
  }

  // Heuristic fallback based on provider family
  if (modelLower.includes("claude")) return { maxTokens: 200000, reserveTokens: 10000 }
  if (modelLower.includes("gemini")) return { maxTokens: 1048576, reserveTokens: 10000 }
  if (modelLower.includes("gpt")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("deepseek")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("qwen")) return { maxTokens: 131072, reserveTokens: 8000 }

  // Default for unknown models
  return { maxTokens: 100000, reserveTokens: 2000 }
}

/**
 * Get the maximum context window tokens for a model.
 * Convenience wrapper around getModelContextLimits.
 */
export function getModelMaxTokens(model: string): number {
  return getModelContextLimits(model).maxTokens
}
