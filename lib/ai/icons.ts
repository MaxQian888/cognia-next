/**
 * Unified AI Model/Provider Icon Utilities
 *
 * Centralizes provider icon paths, brand colors, display names,
 * and model-to-provider resolution for consistent icon display.
 */

import { resolveModelsDevProviderId } from "@/lib/ai/providers/models-dev-id-map"

// ============================================================================
// Provider Icon Registry
// ============================================================================

export interface ProviderIconInfo {
  /** Provider display name */
  name: string
  /** Local SVG icon path (relative to /public) */
  localIcon: string
  /** Brand color (hex) for avatar backgrounds */
  brandColor: string
  /** Whether this provider has a local SVG file */
  hasLocalIcon: boolean
}

/**
 * Registry of all known AI providers with their icon metadata.
 * Provider IDs match those used in PROVIDERS and providerSettings.
 */
const PROVIDER_ICON_REGISTRY: Record<string, ProviderIconInfo> = {
  openai: {
    name: "OpenAI",
    localIcon: "/icons/providers/openai.svg",
    brandColor: "#10a37f",
    hasLocalIcon: true,
  },
  anthropic: {
    name: "Anthropic",
    localIcon: "/icons/providers/anthropic.svg",
    brandColor: "#d4a574",
    hasLocalIcon: true,
  },
  google: {
    name: "Google AI",
    localIcon: "/icons/providers/google.svg",
    brandColor: "#4285f4",
    hasLocalIcon: true,
  },
  deepseek: {
    name: "DeepSeek",
    localIcon: "/icons/providers/deepseek.svg",
    brandColor: "#4d6bfe",
    hasLocalIcon: true,
  },
  groq: {
    name: "Groq",
    localIcon: "/icons/providers/groq.svg",
    brandColor: "#f55036",
    hasLocalIcon: true,
  },
  mistral: {
    name: "Mistral AI",
    localIcon: "/icons/providers/mistral.svg",
    brandColor: "#ff7000",
    hasLocalIcon: true,
  },
  xai: {
    name: "xAI",
    localIcon: "/icons/providers/xai.svg",
    brandColor: "#1da1f2",
    hasLocalIcon: true,
  },
  togetherai: {
    name: "Together AI",
    localIcon: "/icons/providers/togetherai.svg",
    brandColor: "#6366f1",
    hasLocalIcon: true,
  },
  openrouter: {
    name: "OpenRouter",
    localIcon: "/icons/providers/openrouter.svg",
    brandColor: "#6466f1",
    hasLocalIcon: true,
  },
  cohere: {
    name: "Cohere",
    localIcon: "/icons/providers/cohere.svg",
    brandColor: "#39594d",
    hasLocalIcon: true,
  },
  fireworks: {
    name: "Fireworks.ai",
    localIcon: "/icons/providers/fireworks.svg",
    brandColor: "#ff6b35",
    hasLocalIcon: true,
  },
  cerebras: {
    name: "Cerebras",
    localIcon: "/icons/providers/cerebras.svg",
    brandColor: "#ff4f00",
    hasLocalIcon: true,
  },
  sambanova: {
    name: "SambaNova",
    localIcon: "/icons/providers/sambanova.svg",
    brandColor: "#ff6600",
    hasLocalIcon: true,
  },
  zhipu: {
    name: "Zhipu AI (智谱清言)",
    localIcon: "/icons/providers/zhipu.png",
    brandColor: "#2563eb",
    hasLocalIcon: true,
  },
  minimax: {
    name: "MiniMax",
    localIcon: "/icons/providers/minimax.png",
    brandColor: "#0f766e",
    hasLocalIcon: true,
  },
  ollama: {
    name: "Ollama",
    localIcon: "/icons/providers/ollama.svg",
    brandColor: "#ffffff",
    hasLocalIcon: true,
  },
  lmstudio: {
    name: "LM Studio",
    localIcon: "/icons/providers/lmstudio.svg",
    brandColor: "#6c63ff",
    hasLocalIcon: true,
  },
  vllm: {
    name: "vLLM",
    localIcon: "/icons/providers/vllm.svg",
    brandColor: "#7c3aed",
    hasLocalIcon: true,
  },
  llamacpp: {
    name: "llama.cpp",
    localIcon: "/icons/providers/llamacpp.svg",
    brandColor: "#ff8236",
    hasLocalIcon: true,
  },
  llamafile: {
    name: "llamafile",
    localIcon: "/icons/providers/llamafile.svg",
    brandColor: "#e66000",
    hasLocalIcon: true,
  },
  localai: {
    name: "LocalAI",
    localIcon: "/icons/providers/localai.svg",
    brandColor: "#1e88e5",
    hasLocalIcon: true,
  },
  jan: {
    name: "Jan",
    localIcon: "/icons/providers/jan.svg",
    brandColor: "#1a1a2e",
    hasLocalIcon: true,
  },
  textgenwebui: {
    name: "Text Gen WebUI",
    localIcon: "/icons/providers/textgenwebui.svg",
    brandColor: "#4caf50",
    hasLocalIcon: true,
  },
  koboldcpp: {
    name: "KoboldCpp",
    localIcon: "/icons/providers/koboldcpp.svg",
    brandColor: "#8b5cf6",
    hasLocalIcon: true,
  },
  tabbyapi: {
    name: "TabbyAPI",
    localIcon: "/icons/providers/tabbyapi.svg",
    brandColor: "#f59e0b",
    hasLocalIcon: true,
  },
  cliproxyapi: {
    name: "CLIProxyAPI",
    localIcon: "/icons/providers/cliproxyapi.svg",
    brandColor: "#3b82f6",
    hasLocalIcon: true,
  },
}

// CDN fallback base URL for providers without local icons. Logos are keyed by
// the models.dev provider id, so we reuse the authoritative our-id ↔ models.dev-id
// map (single source of truth in models-dev-id-map.ts) instead of a parallel table.
const CDN_ICON_BASE = "https://models.dev/logos"

// ============================================================================
// Provider Icon Resolution
// ============================================================================

/**
 * Get the icon info for a provider. Returns registry entry or generates a fallback.
 */
export function getProviderIconInfo(providerId: string): ProviderIconInfo {
  const normalized = providerId.toLowerCase()
  if (PROVIDER_ICON_REGISTRY[normalized]) {
    return PROVIDER_ICON_REGISTRY[normalized]
  }

  // Generate fallback for unknown providers
  return {
    name: providerId,
    localIcon: `/icons/providers/${normalized}.svg`,
    brandColor: "#6b7280",
    hasLocalIcon: false,
  }
}

/**
 * Get the best available icon path for a provider.
 * Prefers local SVG, falls back to CDN URL.
 */
export function getProviderIconPath(providerId: string): string {
  const info = getProviderIconInfo(providerId)
  if (info.hasLocalIcon) {
    return info.localIcon
  }

  // Try CDN fallback — logos are keyed by the models.dev provider id.
  const cdnId = resolveModelsDevProviderId(providerId) ?? providerId.toLowerCase()
  return `${CDN_ICON_BASE}/${cdnId}.svg`
}

/**
 * Get the brand color for a provider (for avatar backgrounds, etc.)
 */
export function getProviderBrandColor(providerId: string): string {
  return getProviderIconInfo(providerId).brandColor
}

/**
 * Get the display name for a provider.
 */
export function getProviderDisplayName(providerId: string): string {
  return getProviderIconInfo(providerId).name
}

// ============================================================================
// Model → Provider Resolution
// ============================================================================

/**
 * Model ID prefix patterns mapped to provider IDs.
 * Used to infer provider from model ID when provider is unknown.
 */
const MODEL_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^(gpt-|o1-|o3-|dall-e|text-|whisper|tts-)/i, provider: "openai" },
  { pattern: /^(claude-)/i, provider: "anthropic" },
  { pattern: /^(gemini-|gemma)/i, provider: "google" },
  { pattern: /^(deepseek-)/i, provider: "deepseek" },
  { pattern: /^(grok-)/i, provider: "xai" },
  { pattern: /^(mistral-|mixtral|codestral|pixtral|ministral)/i, provider: "mistral" },
  { pattern: /^(llama-|llama3|meta-llama)/i, provider: "meta" },
  { pattern: /^(command-)/i, provider: "cohere" },
  { pattern: /^(qwen)/i, provider: "alibaba" },
]

/**
 * Attempt to resolve the provider from a model ID string.
 * Returns the provider ID or null if unknown.
 */
export function resolveProviderFromModel(modelId: string): string | null {
  for (const { pattern, provider } of MODEL_PROVIDER_PATTERNS) {
    if (pattern.test(modelId)) {
      return provider
    }
  }
  return null
}

// ============================================================================
// Model Display Names
// ============================================================================

/**
 * Common model ID → display name mappings for cleaner UI display.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-4": "GPT-4",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
  "o1-preview": "o1 Preview",
  "o1-mini": "o1 Mini",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-haiku-4-20250514": "Claude Haiku 4",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "gemini-2.0-flash-exp": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-coder": "DeepSeek Coder",
  "deepseek-reasoner": "DeepSeek Reasoner",
  "grok-3": "Grok 3",
  "grok-3-mini": "Grok 3 Mini",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "mixtral-8x7b-32768": "Mixtral 8x7B",
  "mistral-large-latest": "Mistral Large",
  "mistral-small-latest": "Mistral Small",
  "codestral-latest": "Codestral",
  "command-r-plus": "Command R+",
  "command-r": "Command R",
}

/**
 * Get the human-friendly display name for a model.
 * Falls back to the raw model ID if no mapping exists.
 */
export function getModelDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] || modelId
}

// ============================================================================
// Provider First Letter (for fallback avatars)
// ============================================================================

/**
 * Get a single character to represent the provider (for fallback avatars).
 */
export function getProviderInitial(providerId: string): string {
  const info = getProviderIconInfo(providerId)
  return info.name.charAt(0).toUpperCase()
}

/**
 * Check if a provider has a local icon file available.
 */
export function hasLocalProviderIcon(providerId: string): boolean {
  return PROVIDER_ICON_REGISTRY[providerId.toLowerCase()]?.hasLocalIcon ?? false
}

/**
 * Get all registered provider IDs.
 */
export function getAllProviderIds(): string[] {
  return Object.keys(PROVIDER_ICON_REGISTRY)
}
