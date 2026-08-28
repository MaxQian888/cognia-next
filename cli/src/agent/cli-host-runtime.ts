/**
 * The CLI's per-session plugin host runtime.
 *
 * The CLI runs the renderer's plugin manager inside Node, where the Zustand
 * stores every renderer API reads are never hydrated — and where several
 * sessions live in ONE process, each with its own resolved provider, API key,
 * search policy and usage accounting. There is no "current" anything to read.
 *
 * So the CLI binds a runtime per session (`registerSessionHostRuntime`) and
 * turns ambient resolution off (`disableAmbientHostRuntime`). A plugin call
 * that names a session gets exactly that session's credentials; a call that
 * names none fails closed instead of silently reading an empty store or
 * borrowing another session's account.
 *
 * This replaces the Deep-Research-shaped injection this file's ancestors did
 * (`resolveDeepResearchAiBridge`, `PluginToolContext.hostContext`): the wiring
 * is now generic, so every plugin gets the CLI's provider and web policy the
 * same way and the host no longer knows any plugin by name.
 */

import {
  DEFAULT_EMBEDDING_MODELS,
  generateEmbeddings,
  type EmbeddingProvider,
} from "@cognia/vector/embedding"

import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { runAuthorCallableHostTool } from "@/lib/plugin/runtime/author-host-tools"
import {
  disableAmbientHostRuntime,
  registerSessionHostRuntime,
  type PluginHostRuntime,
} from "@/lib/plugin/runtime/host-runtime"
import type { AIChatChunk, AIChatMessage, AIChatOptions } from "@/types/plugin"
import type { PluginAuthorCallableHostTool } from "@/types/plugin/plugin-host-tools"

import { buildCliWebToolDeps } from "../config/web-tool-deps"
import { resolveActiveModel } from "../config/active-model"
import type { ProviderConfig, ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"

/** Protocols `@cognia/vector/embedding` can actually drive. */
const EMBEDDING_PROTOCOLS = new Set(["openai", "google", "cohere", "mistral"])

interface EmbeddingBinding {
  provider: EmbeddingProvider
  apiKey: string
  baseURL?: string
}

export interface CliHostRuntimeDeps {
  buildClient?: typeof buildRendererLlmClient
  embed?: typeof generateEmbeddings
}

/**
 * Pick an embedding-capable provider from the session's config: the active one
 * when it can embed, else the first configured provider that can. Returns null
 * when none can — the caller then reports "no embedding provider" rather than
 * dispatching to a chat-only endpoint and failing obscurely.
 */
function embeddingBinding(config: ResolvedConfig): EmbeddingBinding | null {
  const ids = [
    config.provider,
    ...Object.keys(config.providers).filter((id) => id !== config.provider),
  ]
  for (const id of ids) {
    const provider: ProviderConfig | undefined = config.providers[id]
    if (!provider?.apiKey) continue
    const protocol = provider.protocol ?? id
    if (!EMBEDDING_PROTOCOLS.has(protocol)) continue
    return {
      provider: protocol as EmbeddingProvider,
      apiKey: provider.apiKey,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    }
  }
  return null
}

/**
 * Flatten a plugin's message list onto the renderer LLM client's
 * `(prompt, {system})` shape. System turns are hoisted; the rest keep their
 * role prefix so a multi-turn history survives the flattening.
 */
function modelPrompt(messages: AIChatMessage[]): { prompt: string; system?: string } {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
  const prompt = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n")
  return { prompt, ...(system ? { system } : {}) }
}

class CliHostRuntimeError extends Error {
  readonly code = "NO_PROVIDER_AVAILABLE" as const
  readonly suggestion: string

  constructor(reason: string, suggestion: string) {
    super(reason)
    this.name = "CliHostRuntimeError"
    this.suggestion = suggestion
  }
}

/**
 * Build the runtime for one CLI session from its already-resolved config.
 *
 * Synchronous by contract (see `PluginHostRuntimeFactory`): everything here is
 * a pure read of `config`, and the async work lives inside the returned
 * methods.
 */
export function createCliHostRuntime(
  config: ResolvedConfig,
  sessionId: string,
  deps: CliHostRuntimeDeps = {}
): PluginHostRuntime {
  const runEmbedding = deps.embed ?? generateEmbeddings

  const chatClient = () => {
    const context = toBuildContext({ sessionId, config })
    const client = (deps.buildClient ?? buildRendererLlmClient)({
      session: context.session,
      appSettings: context.appSettings,
      featureId: "cli-plugin-host",
    })
    if (!client) {
      throw new CliHostRuntimeError(
        `No usable model provider is configured for CLI session ${sessionId}.`,
        "Add a provider API key to your Cognia CLI config (`cognia config`), then retry."
      )
    }
    return client
  }

  return {
    runHostTool: (
      name: PluginAuthorCallableHostTool,
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) => runAuthorCallableHostTool(name, args, buildCliWebToolDeps(config), options),

    chat: async function* (
      messages: AIChatMessage[],
      options?: AIChatOptions
    ): AsyncIterable<AIChatChunk> {
      const client = chatClient()
      const { prompt, system } = modelPrompt(messages)
      // The client accumulates usage per instance; diff the snapshot around the
      // call so a plugin sees the tokens ITS call spent, not the session total.
      const before = client.getUsageSnapshot?.()
      const content = await client.complete(prompt, {
        system,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        stopSequences: options?.stop,
      })
      const after = client.getUsageSnapshot?.()
      const promptTokens = Math.max(0, (after?.inputTokens ?? 0) - (before?.inputTokens ?? 0))
      const completionTokens = Math.max(0, (after?.outputTokens ?? 0) - (before?.outputTokens ?? 0))
      yield {
        content,
        ...(after
          ? {
              usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              },
            }
          : {}),
      }
    },

    embed: async (texts: string[]): Promise<number[][]> => {
      const embedding = embeddingBinding(config)
      if (!embedding) {
        throw new CliHostRuntimeError(
          `No embedding-capable provider is configured for CLI session ${sessionId}.`,
          "Add an OpenAI / Google / Cohere / Mistral key to your Cognia CLI config."
        )
      }
      const defaults = DEFAULT_EMBEDDING_MODELS[embedding.provider]
      const result = await runEmbedding(
        texts,
        {
          provider: embedding.provider,
          model: defaults.model,
          dimensions: defaults.dimensions,
          baseURL: embedding.baseURL,
        },
        embedding.apiKey
      )
      return result.embeddings
    },

    getDefaultProvider: () => config.provider,
    getDefaultModel: () => resolveActiveModel(config) ?? "",
  }
}

/**
 * Bind `sessionId` to its config for the lifetime of a CLI session, and make
 * this process session-scoped. Returns the disposer the session's teardown must
 * call — an unreleased binding would hand a later session that reuses the id
 * the previous one's credentials.
 */
export function bindCliSessionHostRuntime(
  config: ResolvedConfig,
  sessionId: string,
  deps: CliHostRuntimeDeps = {}
): () => void {
  // Do this on the first bind rather than at module load: importing this module
  // must not, by itself, change how an embedding host resolves runtimes.
  disableAmbientHostRuntime()
  return registerSessionHostRuntime(sessionId, () => createCliHostRuntime(config, sessionId, deps))
}
