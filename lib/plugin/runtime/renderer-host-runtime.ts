/**
 * The ambient host runtime — renderer, Tauri desktop and the Capacitor mobile
 * shell. All three mount the same Zustand settings store and the same provider
 * services, so all three resolve identically and share this one adapter.
 *
 * It owns nothing of its own: search/fetch policy comes from
 * `resolveWebToolDeps()` (the same snapshot the agent's promoted web built-ins
 * use) and model resolution from `lib/ai/provider-consumption`. Keeping it a
 * thin adapter is the point — a second copy of either policy is exactly the
 * drift this whole refactor removes.
 *
 * The CLI deliberately does NOT use this: it has no hydrated store, and several
 * sessions with different credentials run in one process. It registers its own
 * per-session runtimes instead (see `lib/plugin/runtime/host-runtime.ts`).
 */

import { streamText, type ModelMessage } from "ai"

import { partitionPrompt } from "@/lib/ai/prompt-partition"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import {
  DEFAULT_EMBEDDING_MODELS,
  generateEmbeddings,
  type EmbeddingProvider,
} from "@cognia/vector/embedding"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AIChatChunk, AIChatMessage, AIChatOptions, AIEmbedOptions } from "@/types/plugin"
import type { PluginAuthorCallableHostTool } from "@/types/plugin/plugin-host-tools"

import { runAuthorCallableHostTool } from "./author-host-tools"
import type { PluginHostRuntime, PluginHostRuntimeRequest } from "./host-runtime"

type PluginAIProviderStructuredError = Error & {
  code: "NO_PROVIDER_AVAILABLE"
  suggestion: string
  details?: unknown
}

/**
 * A built-in provider id, mapped onto the embedding catalog's own id space.
 * Only `bedrock` differs; everything else is the same string.
 *
 * The catalog (`DEFAULT_EMBEDDING_MODELS` in `@cognia/vector/embedding`, built
 * from `RAG_EMBEDDING_PROVIDERS`) is the single source for which model each
 * provider embeds with. This host used to keep a hand-written copy of five of
 * those ids — the CLI runtime imports the catalog, so a model-id bump reached
 * the CLI and not the renderer, and `ctx.ai.embed` produced vectors from a
 * different model depending on the shell.
 */
function embeddingProviderId(providerId: string): EmbeddingProvider | null {
  const candidate = providerId === "bedrock" ? "amazon-bedrock" : providerId
  return candidate in DEFAULT_EMBEDDING_MODELS ? (candidate as EmbeddingProvider) : null
}

export function createNoProviderAvailableError(
  reason: string,
  nextAction?: string,
  details?: unknown
): PluginAIProviderStructuredError {
  const suggestion = (() => {
    switch (nextAction) {
      case "add_api_key":
        return "在 Settings -> Providers 中为默认 provider 添加 API key。"
      case "enable_provider":
        return "在 Settings -> Providers 中启用默认 provider。"
      case "configure_base_url":
        return "在 Settings -> Providers 中补全默认 provider 的 base URL。"
      case "select_default_model":
        return "在 Settings -> Providers 中为默认 provider 选择可用模型。"
      case "verify_connection":
        return "在 Settings -> Providers 中验证默认 provider 的连接状态。"
      default:
        return "在 Settings -> Providers 中检查默认 built-in provider 的配置。"
    }
  })()

  return Object.assign(new Error(reason), {
    code: "NO_PROVIDER_AVAILABLE" as const,
    suggestion,
    details,
  })
}

function resolveBuiltInProviderFallback() {
  const settings = useSettingsStore.getState()
  const builtInProviderIds = Object.keys(settings.providerSettings || {})
  const preferredBuiltInProvider = builtInProviderIds.includes(settings.defaultProvider)
    ? settings.defaultProvider
    : undefined

  const resolution = resolveFeatureProvider(
    {
      featureId: "plugin-ai-provider-fallback",
      routeProfile: "general-text",
      selectionMode: preferredBuiltInProvider ? "explicit-provider" : "supported-providers",
      providerId: preferredBuiltInProvider,
      supportedProviders: builtInProviderIds,
      fallbackMode: preferredBuiltInProvider ? "ordered" : "first-eligible",
      fallbackProviderOrder: preferredBuiltInProvider
        ? builtInProviderIds.filter((providerId) => providerId !== preferredBuiltInProvider)
        : undefined,
      executionMode: "direct-model",
      proxyMode: "preferred",
    },
    createProviderSettingsSnapshot({
      defaultProvider: settings.defaultProvider,
      providerSettings: settings.providerSettings,
      customProviders: settings.customProviders,
    })
  )

  if (resolution.kind !== "resolved") {
    throw createNoProviderAvailableError(resolution.reason, resolution.nextAction, resolution)
  }

  return resolution
}

async function* streamBuiltInChat(
  messages: AIChatMessage[],
  options?: AIChatOptions
): AsyncIterable<AIChatChunk> {
  const resolution = resolveBuiltInProviderFallback()
  const model = createFeatureProviderModel(resolution)
  // Plugin-supplied histories routinely lead with a system turn; AI SDK 7
  // rejects `{ role: "system" }` inside `messages`, so hoist it into the
  // top-level instructions option.
  const streamOptions: Record<string, unknown> = {
    model,
    ...partitionPrompt(messages as ModelMessage[]),
  }
  if (options?.temperature !== undefined) {
    streamOptions.temperature = options.temperature
  }
  if (options?.maxTokens !== undefined) {
    // `AIChatOptions.maxTokens` is the plugin-facing name; the AI SDK option
    // has been `maxOutputTokens` since v5, so the old key was silently
    // dropped and every plugin cap went unenforced.
    streamOptions.maxOutputTokens = options.maxTokens
  }
  if (options?.topP !== undefined) {
    streamOptions.topP = options.topP
  }
  if (options?.stop?.length) {
    streamOptions.stopSequences = options.stop
  }
  if (options?.signal) {
    streamOptions.abortSignal = options.signal
  }

  const result = streamText(streamOptions as Parameters<typeof streamText>[0])
  for await (const chunk of result.textStream) {
    yield { content: chunk }
  }

  // Surface end-of-stream token usage on a trailing chunk so plugins can
  // track cost. `streamText` resolves `.usage` after the stream drains;
  // only emit when the provider actually reported counts. Tolerates both
  // the AI-SDK field naming (`inputTokens`/`outputTokens`) and the legacy
  // `promptTokens`/`completionTokens` shape.
  const usage = (await Promise.resolve(result.usage).catch(() => undefined)) as
    Record<string, number | undefined> | undefined
  const promptTokens = usage?.inputTokens ?? usage?.promptTokens
  const completionTokens = usage?.outputTokens ?? usage?.completionTokens
  if (typeof promptTokens === "number" || typeof completionTokens === "number") {
    const p = promptTokens ?? 0
    const c = completionTokens ?? 0
    yield {
      content: "",
      finishReason: "stop",
      usage: { promptTokens: p, completionTokens: c, totalTokens: usage?.totalTokens ?? p + c },
    }
  }
}

async function embedWithBuiltInProvider(texts: string[]): Promise<number[][]> {
  const resolution = resolveBuiltInProviderFallback()
  const embeddingProvider = embeddingProviderId(resolution.providerId)
  if (!embeddingProvider) {
    throw createNoProviderAvailableError(
      `Built-in provider ${resolution.providerId} does not expose an embedding model for plugin fallback.`,
      "open_provider_settings",
      resolution
    )
  }

  const defaults = DEFAULT_EMBEDDING_MODELS[embeddingProvider]
  const result = await generateEmbeddings(
    texts,
    {
      provider: embeddingProvider,
      model: defaults.model,
      dimensions: defaults.dimensions,
      baseURL: resolution.baseURL,
      bedrock: resolution.bedrock,
    },
    resolution.apiKey || ""
  )
  return result.embeddings
}

/**
 * Build the ambient runtime for one call. Cheap enough to construct per call —
 * every read below goes to the live store, so caching it would be the thing
 * that goes stale when the user changes providers mid-session.
 */
export function createRendererHostRuntime(_request: PluginHostRuntimeRequest): PluginHostRuntime {
  return {
    runHostTool: async (
      name: PluginAuthorCallableHostTool,
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) => {
      const { resolveWebToolDeps } = await import("@/lib/claude/plugin-tool-ipc")
      return runAuthorCallableHostTool(name, args, await resolveWebToolDeps(), options)
    },
    chat: (messages: AIChatMessage[], options?: AIChatOptions) =>
      streamBuiltInChat(messages, options),
    embed: (texts: string[], _options?: AIEmbedOptions) => embedWithBuiltInProvider(texts),
    getDefaultProvider: () => useSettingsStore.getState().defaultProvider,
    getDefaultModel: () => {
      const settings = useSettingsStore.getState()
      return settings.providerSettings?.[settings.defaultProvider]?.defaultModel || "gpt-4o"
    },
  }
}
