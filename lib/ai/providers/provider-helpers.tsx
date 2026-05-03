/**
 * Provider helper functions and constants
 * Extracted from components/settings/provider/provider-settings.tsx
 */

import React from "react"
import { Sparkles, Globe, Zap, Server, Cpu } from "lucide-react"
import { PROVIDERS } from "@/types/provider"
import {
  BUILT_IN_PROVIDER_IDS,
  getBuiltInProviderCatalogEntry,
} from "@/types/provider/built-in-provider-catalog"

// Helper to get dashboard URL for each provider
export function getProviderDashboardUrl(providerId: string): string {
  const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
  if (catalogEntry?.dashboardUrl) return catalogEntry.dashboardUrl
  const provider = PROVIDERS[providerId]
  if (provider?.dashboardUrl) return provider.dashboardUrl

  const urls: Record<string, string> = {
    openai: "https://platform.openai.com/api-keys",
    anthropic: "https://console.anthropic.com/settings/keys",
    google: "https://aistudio.google.com/app/apikey",
    deepseek: "https://platform.deepseek.com/api_keys",
    groq: "https://console.groq.com/keys",
    mistral: "https://console.mistral.ai/api-keys/",
    xai: "https://console.x.ai/team/api-keys",
    togetherai: "https://api.together.xyz/settings/api-keys",
    openrouter: "https://openrouter.ai/keys",
    cohere: "https://dashboard.cohere.com/api-keys",
    fireworks: "https://fireworks.ai/account/api-keys",
    cerebras: "https://cloud.cerebras.ai/platform",
    sambanova: "https://cloud.sambanova.ai/apis",
    zhipu: "https://open.bigmodel.cn/usercenter/apikeys",
    minimax: "https://platform.minimaxi.com",
    // Local providers - link to documentation/websites
    ollama: "https://ollama.ai",
    lmstudio: "https://lmstudio.ai",
    llamacpp: "https://github.com/ggerganov/llama.cpp",
    llamafile: "https://github.com/Mozilla-Ocho/llamafile",
    vllm: "https://docs.vllm.ai",
    localai: "https://localai.io",
    jan: "https://jan.ai",
    textgenwebui: "https://github.com/oobabooga/text-generation-webui",
    koboldcpp: "https://github.com/LostRuins/koboldcpp",
    tabbyapi: "https://github.com/theroyallab/tabbyAPI",
    // Proxy/Aggregator providers
    cliproxyapi: "http://localhost:8317/management.html",
  }
  return urls[providerId] || "#"
}

// Get provider description
export function getProviderDescription(providerId: string): string {
  const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
  if (catalogEntry?.description) return catalogEntry.description
  const provider = PROVIDERS[providerId]
  if (provider?.description) return provider.description

  const descriptions: Record<string, string> = {
    openai: "GPT-4o, o1, and more flagship models",
    anthropic: "Claude 4 Sonnet, Claude 4 Opus",
    google: "Gemini 2.0 Flash, Gemini 1.5 Pro",
    deepseek: "DeepSeek Chat, DeepSeek Reasoner",
    groq: "Ultra-fast inference with Llama 3.3",
    mistral: "Mistral Large, Mistral Small",
    xai: "Grok 3, Grok 3 Mini",
    togetherai: "Fast inference for open source models",
    openrouter: "Access 200+ models with OAuth login",
    cohere: "Command R+, enterprise RAG",
    fireworks: "Ultra-fast compound AI",
    cerebras: "Fastest inference with custom AI chips",
    sambanova: "Enterprise AI with free tier",
    zhipu: "GLM models for Chinese and coding workflows",
    minimax: "MiniMax chat models with coding-oriented options",
    cliproxyapi: "Self-hosted AI proxy aggregating multiple providers",
    ollama: "Run models locally on your machine",
    // New local providers
    lmstudio: "Desktop app for running local LLMs",
    llamacpp: "High-performance C++ inference server",
    llamafile: "Single-file executable LLM server",
    vllm: "High-throughput GPU inference engine",
    localai: "Self-hosted OpenAI alternative",
    jan: "Open-source ChatGPT alternative",
    textgenwebui: "Gradio web UI with OpenAI API",
    koboldcpp: "Easy-to-use llama.cpp fork",
    tabbyapi: "Exllamav2 API server",
  }
  return descriptions[providerId] || ""
}

// Get category icon
export function getCategoryIcon(category?: string): React.ReactNode {
  const icons: Record<string, React.ReactNode> = {
    flagship: <Sparkles className="h-4 w-4" />,
    aggregator: <Globe className="h-4 w-4" />,
    specialized: <Zap className="h-4 w-4" />,
    local: <Server className="h-4 w-4" />,
    enterprise: <Cpu className="h-4 w-4" />,
  }
  return category ? icons[category] || <Cpu className="h-4 w-4" /> : <Cpu className="h-4 w-4" />
}

// Provider categories for filtering
export type ProviderCategory = "all" | "flagship" | "aggregator" | "specialized" | "local"

export const CATEGORY_CONFIG: Record<
  ProviderCategory,
  { label: string; icon: React.ReactNode; description: string }
> = {
  all: { label: "All", icon: null, description: "All providers" },
  flagship: {
    label: "Flagship",
    icon: <Sparkles className="h-3 w-3" />,
    description: "OpenAI, Anthropic, Google, xAI",
  },
  aggregator: {
    label: "Aggregator",
    icon: <Globe className="h-3 w-3" />,
    description: "OpenRouter, CLIProxyAPI, Together AI",
  },
  specialized: {
    label: "Fast",
    icon: <Zap className="h-3 w-3" />,
    description: "Groq, Cerebras, DeepSeek",
  },
  local: {
    label: "Local",
    icon: <Server className="h-3 w-3" />,
    description: "Ollama, LM Studio, vLLM, llama.cpp",
  },
}

// Map provider IDs to categories
export const PROVIDER_CATEGORIES: Record<string, ProviderCategory> = Object.fromEntries(
  BUILT_IN_PROVIDER_IDS.map((providerId) => {
    const category = getBuiltInProviderCatalogEntry(providerId)?.category
    const normalized = category === "enterprise" ? "specialized" : category || "specialized"
    return [providerId, normalized]
  })
) as Record<string, ProviderCategory>
