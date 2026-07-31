import { resolveModelsDevProviderId } from "./models-dev-id-map"

export interface ProviderIconInfo {
  name: string
  localIcon: string
  brandColor: string
  hasLocalIcon: boolean
}

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
  opencode: {
    name: "OpenCode Zen",
    localIcon: "/icons/providers/opencode.svg",
    brandColor: "#fab283",
    hasLocalIcon: false,
  },
  "opencode-go": {
    name: "OpenCode Go",
    localIcon: "/icons/providers/opencode.svg",
    brandColor: "#fab283",
    hasLocalIcon: false,
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
    name: "Zhipu AI",
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

const CDN_ICON_BASE = "https://models.dev/logos"

export function getProviderIconInfo(providerId: string): ProviderIconInfo {
  const normalized = providerId.toLowerCase()
  if (PROVIDER_ICON_REGISTRY[normalized]) {
    return PROVIDER_ICON_REGISTRY[normalized]
  }

  return {
    name: providerId,
    localIcon: `/icons/providers/${normalized}.svg`,
    brandColor: "#6b7280",
    hasLocalIcon: false,
  }
}

export function getProviderIconPath(providerId: string): string {
  const info = getProviderIconInfo(providerId)
  if (info.hasLocalIcon) {
    return info.localIcon
  }

  const cdnId = resolveModelsDevProviderId(providerId) ?? providerId.toLowerCase()
  return `${CDN_ICON_BASE}/${cdnId}.svg`
}
