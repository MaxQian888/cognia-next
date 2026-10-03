/**
 * Renderer side of `vscode.lm`: the language model the user configured in
 * Cognia, offered to VS Code extensions.
 *
 * `lm:selectChatModels` describes one model: the provider and model the
 * plugin AI API (`ctx.ai`) would use, as vendor `cognia`. Extensions never
 * bring their own key or provider.
 *
 * `lm:sendChatRequest` checks the request before anything leaves the device,
 * and answers with the `LanguageModelError` code the host throws:
 *   - the model must still be the app's (`NotFound` after the user changed it);
 *   - the extension must hold `ai:chat` (`NoPermissions`);
 *   - the plugin rate limit for `ai:chat` applies (`Blocked`);
 *   - every message (and its name and the stop sequences) must pass the PII
 *     gate (`Blocked`).
 * System messages are accepted only before the conversation.
 * The request then runs through `ctx.ai.chat` (which applies the permission
 * and PII gate again) with the app's provider, streaming. The host pulls the
 * text with `lm:readChatResponse`, which waits until there is some, and can
 * cancel with `lm:cancelChatRequest`.
 *
 * `lm:countTokens` estimates with the shared tokenizer
 * (`lib/ai/tokens/fallback-estimator.ts`): the app's provider may be any
 * vendor, and none of them count tokens on the device.
 *
 * When the app's model changes, every host hears `lm:modelsChanged`.
 *
 * Not supported, and logged to the extension's log where an extension meets
 * it: tools (a request with `toolMode: Required` is refused, other tools are
 * dropped), and the registrations nothing calls (`lm.registerTool`,
 * `registerChatModelProvider`, `registerMcpServerDefinitionProvider`).
 */

import { getModelConfig } from "@cognia/provider-types/provider"

import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { createAIProviderAPI } from "@/lib/plugin/api/ai-provider-api"
import { hasApiOrGuardPermission } from "@/lib/plugin/api/api-permission-gate"
import { assertNoLeakingPii, PluginPiiError } from "@/lib/plugin/api/plugin-pii-gate"
import { PluginHostRuntimeUnavailableError } from "@/lib/plugin/runtime/host-runtime"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { getPluginRateLimiter, RateLimitError } from "@/lib/plugin/security/rate-limiter"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AIChatChunk, AIChatMessage, AIChatOptions } from "@/types/plugin/plugin"

import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"

/** A model as `lm.selectChatModels` describes it to the host. */
export interface VscodeLmChatModel {
  id: string
  name: string
  vendor: "cognia"
  family: string
  version: string
  maxInputTokens: number
  /** Whether this extension may send it requests: it holds `ai:chat`. */
  canSendRequest: boolean
}

/** A refusal or failure, by the `LanguageModelError` code the host throws. */
export interface VscodeLmError {
  code: "NoPermissions" | "Blocked" | "NotFound" | "Cancelled" | "Unknown"
  message: string
}

/** One read of a response: the text since the last read. */
export interface VscodeLmChunk {
  text: string
  done: boolean
  error?: VscodeLmError
}

/** Input budget for a model the provider catalog does not know. */
export const UNKNOWN_MODEL_INPUT_TOKENS = 8_192

/** `toolMode` values (`LanguageModelChatToolMode`). */
const TOOL_MODE_REQUIRED = 2

export interface VscodeLmDependencies {
  /** The provider and model `ctx.ai` would use for this extension, or `null` for none. */
  currentModel(pluginId: string): { providerId: string; modelId: string } | null
  /** What the provider catalog knows about a model. */
  modelInfo(providerId: string, modelId: string): { name?: string; maxInputTokens?: number } | null
  /** Whether the extension holds `ai:chat`. */
  hasPermission(pluginId: string): boolean
  /** Take one `ai:chat` from the plugin rate limit; throws `RateLimitError` when spent. */
  rateLimit(pluginId: string): void
  /** `ctx.ai.chat` for the extension. */
  chat(
    pluginId: string,
    messages: AIChatMessage[],
    options: AIChatOptions
  ): AsyncIterable<AIChatChunk>
  countTokens(text: string): number
  /** Something that decides the app's model may have changed. */
  subscribeModels(listener: () => void): () => void
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  hosts(): string[]
}

export function createVscodeLmDependencies(input: {
  sendToHost: VscodeLmDependencies["sendToHost"]
  hosts: VscodeLmDependencies["hosts"]
}): VscodeLmDependencies {
  return {
    ...input,
    currentModel: (pluginId) => {
      const api = createAIProviderAPI(pluginId)
      const providerId = api.getDefaultProvider()
      const modelId = api.getDefaultModel()
      return providerId && modelId ? { providerId, modelId } : null
    },
    modelInfo: (providerId, modelId) => {
      const config = getModelConfig(providerId, modelId)
      return config
        ? { name: config.name, maxInputTokens: config.maxInputTokens ?? config.contextLength }
        : null
    },
    hasPermission: (pluginId) => hasApiOrGuardPermission(pluginId, "ai:chat"),
    rateLimit: (pluginId) => getPluginRateLimiter().check(pluginId, "ai:chat"),
    chat: (pluginId, messages, options) => createAIProviderAPI(pluginId).chat(messages, options),
    countTokens: (text) => estimateFallbackTokens(text),
    subscribeModels: (listener) =>
      useSettingsStore.subscribe((state, previous) => {
        if (
          state.defaultProvider !== previous.defaultProvider ||
          state.providerSettings !== previous.providerSettings ||
          state.customProviders !== previous.customProviders
        ) {
          listener()
        }
      }),
  }
}

interface ChatStream {
  pluginId: string
  controller: AbortController
  text: string
  done: boolean
  error?: VscodeLmError
  waiters: Array<() => void>
}

let deps: VscodeLmDependencies | null = null
let unsubscribe: (() => void) | null = null
const streams = new Map<string, ChatStream>()
/** Per host, the models it was last told about (as JSON). */
const delivered = new Map<string, string>()

function requireDeps(): VscodeLmDependencies {
  if (!deps) throw new Error("Language models are not available to VS Code extensions yet")
  return deps
}

function log(pluginId: string, level: "info" | "warn" | "error", message: string): void {
  appendVscodeLog(pluginId, { level, kind: "lm", message })
}

/** The models offered to one extension: the app's, when it has one. */
function modelsFor(pluginId: string): VscodeLmChatModel[] {
  const { currentModel, modelInfo, hasPermission } = requireDeps()
  let current: { providerId: string; modelId: string } | null
  try {
    current = currentModel(pluginId)
  } catch (error) {
    if (error instanceof PluginHostRuntimeUnavailableError) return []
    throw error
  }
  if (!current) return []
  const info = modelInfo(current.providerId, current.modelId)
  return [
    {
      id: `${current.providerId}/${current.modelId}`,
      name: info?.name || current.modelId,
      vendor: "cognia",
      family: current.modelId,
      version: current.modelId,
      maxInputTokens:
        info?.maxInputTokens && info.maxInputTokens > 0
          ? info.maxInputTokens
          : UNKNOWN_MODEL_INPUT_TOKENS,
      canSendRequest: hasPermission(pluginId),
    },
  ]
}

async function deliverModels(pluginId: string): Promise<void> {
  const models = modelsFor(pluginId)
  const key = JSON.stringify(models)
  if (delivered.get(pluginId) === key) return
  delivered.set(pluginId, key)
  await requireDeps().sendToHost(pluginId, "lm:modelsChanged", { models })
}

export function configureVscodeLm(next: VscodeLmDependencies | null): void {
  unsubscribe?.()
  unsubscribe = null
  delivered.clear()
  deps = next
  if (!next) return
  unsubscribe = next.subscribeModels(() => {
    for (const pluginId of next.hosts()) {
      void deliverModels(pluginId).catch((error: unknown) =>
        log(
          pluginId,
          "warn",
          `Could not tell the extension its language models changed: ${errorMessage(error)}`
        )
      )
    }
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A failure as the `LanguageModelError` code it maps to. */
export function toVscodeLmError(error: unknown): VscodeLmError {
  const message = errorMessage(error)
  if (error instanceof PermissionError) return { code: "NoPermissions", message }
  if (error instanceof PluginPiiError || error instanceof RateLimitError) {
    return { code: "Blocked", message }
  }
  if (
    error instanceof PluginHostRuntimeUnavailableError ||
    (error as { code?: unknown } | null)?.code === "NO_PROVIDER_AVAILABLE"
  ) {
    const suggestion = (error as { suggestion?: unknown }).suggestion
    return {
      code: "NotFound",
      message: typeof suggestion === "string" ? `${message} ${suggestion}` : message,
    }
  }
  return { code: "Unknown", message }
}

function object(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = object(payload)
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || !result) {
    throw new Error(`VS Code RPC payload requires non-empty ${field}`)
  }
  return result
}

function streamKey(pluginId: string, requestId: string): string {
  return `${pluginId}\u0000${requestId}`
}

/**
 * The request's messages. System messages are accepted only before the
 * conversation: they become the request's instructions. One in the middle would
 * reach the model as a system turn inside the history, which is reserved for
 * the app's own prompts (`lib/ai/prompt-partition.ts`).
 */
function parseMessages(value: unknown): AIChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("A language model request needs at least one message")
  }
  let conversationStarted = false
  return value.map((entry, index) => {
    const { role, content, name } = object(entry)
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new Error(`messages[${index}].role must be user, assistant or system`)
    }
    if (role === "system" && conversationStarted) {
      throw new Error(`messages[${index}]: a system message must come before the conversation`)
    }
    if (role !== "system") conversationStarted = true
    if (typeof content !== "string") throw new Error(`messages[${index}].content must be text`)
    return { role, content, ...(typeof name === "string" && name ? { name } : {}) }
  })
}

function numberOption(options: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = options[name]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/** The `modelOptions` Cognia's providers understand, under the names extensions use. */
function chatOptions(modelOptions: unknown): AIChatOptions {
  if (!modelOptions || typeof modelOptions !== "object") return {}
  const options = modelOptions as Record<string, unknown>
  const result: AIChatOptions = {}
  const temperature = numberOption(options, "temperature")
  const maxTokens = numberOption(options, "maxTokens", "max_tokens", "maxOutputTokens")
  const topP = numberOption(options, "topP", "top_p")
  if (temperature !== undefined) result.temperature = temperature
  if (maxTokens !== undefined) result.maxTokens = maxTokens
  if (topP !== undefined) result.topP = topP
  const stop = options.stop
  if (typeof stop === "string") result.stop = [stop]
  else if (Array.isArray(stop) && stop.every((entry) => typeof entry === "string")) {
    result.stop = stop as string[]
  }
  return result
}

function wake(stream: ChatStream): void {
  const waiters = stream.waiters
  stream.waiters = []
  for (const resolve of waiters) resolve()
}

function finish(stream: ChatStream, error?: VscodeLmError): void {
  if (stream.done) return
  stream.done = true
  if (error) stream.error = error
  wake(stream)
}

async function run(stream: ChatStream, messages: AIChatMessage[], options: AIChatOptions) {
  try {
    for await (const chunk of requireDeps().chat(stream.pluginId, messages, {
      ...options,
      signal: stream.controller.signal,
    })) {
      if (stream.done) return
      if (chunk.content) {
        stream.text += chunk.content
        wake(stream)
      }
    }
    finish(stream)
  } catch (error) {
    if (stream.done) return
    const failure = toVscodeLmError(error)
    log(stream.pluginId, "warn", `Language model request failed: ${failure.message}`)
    finish(stream, failure)
  }
}

async function sendChatRequest(
  payload: unknown,
  context: RpcContext
): Promise<{ ok: true } | { error: VscodeLmError }> {
  const value = owned(payload, context)
  const { pluginId } = context
  const requestId = requiredString(value, "requestId")
  const modelId = requiredString(value, "modelId")
  const messages = parseMessages(value.messages)
  const options = value.options && typeof value.options === "object" ? object(value.options) : {}

  const current = modelsFor(pluginId)[0]
  if (!current || current.id !== modelId) {
    return {
      error: {
        code: "NotFound",
        message: current
          ? `The language model ${modelId} is no longer the app's model; select a model again`
          : "No language model is configured in Cognia",
      },
    }
  }
  if (!current.canSendRequest) {
    return {
      error: {
        code: "NoPermissions",
        message: `VS Code extension ${pluginId} requires permission ai:chat`,
      },
    }
  }
  const toolCount = typeof options.toolCount === "number" ? options.toolCount : 0
  if (toolCount > 0) {
    if (options.toolMode === TOOL_MODE_REQUIRED) {
      return {
        error: {
          code: "Unknown",
          message: "This model cannot call tools: Cognia does not give its models extension tools",
        },
      }
    }
    log(pluginId, "info", `Language model request: ${toolCount} tool(s) not given to the model`)
  }
  const chat = chatOptions(options.modelOptions)
  try {
    requireDeps().rateLimit(pluginId)
    // Everything of the extension's that reaches the provider.
    assertNoLeakingPii(pluginId, "vscode.lm.sendRequest", [
      ...messages.flatMap((message) => [message.content, message.name]),
      ...(chat.stop ?? []),
    ])
  } catch (error) {
    return { error: toVscodeLmError(error) }
  }

  const key = streamKey(pluginId, requestId)
  if (streams.has(key)) throw new Error(`Language model request ${requestId} is already running`)
  const stream: ChatStream = {
    pluginId,
    controller: new AbortController(),
    text: "",
    done: false,
    waiters: [],
  }
  streams.set(key, stream)
  void run(stream, messages, chat)
  return { ok: true }
}

async function readChatResponse(payload: unknown, context: RpcContext): Promise<VscodeLmChunk> {
  const requestId = requiredString(owned(payload, context), "requestId")
  const key = streamKey(context.pluginId, requestId)
  const stream = streams.get(key)
  if (!stream) {
    return {
      text: "",
      done: true,
      error: { code: "Unknown", message: `No language model request ${requestId}` },
    }
  }
  while (!stream.text && !stream.done) {
    await new Promise<void>((resolve) => stream.waiters.push(resolve))
  }
  const text = stream.text
  stream.text = ""
  if (stream.done) streams.delete(key)
  return { text, done: stream.done, ...(stream.error ? { error: stream.error } : {}) }
}

function cancelChatRequest(payload: unknown, context: RpcContext): null {
  const requestId = requiredString(owned(payload, context), "requestId")
  const stream = streams.get(streamKey(context.pluginId, requestId))
  if (stream) {
    stream.controller.abort()
    finish(stream, { code: "Cancelled", message: "Canceled" })
  }
  return null
}

/** Stop every request an extension has running; its host is going away. */
export function unregisterAllLmFor(pluginId: string): void {
  for (const [key, stream] of streams) {
    if (stream.pluginId !== pluginId) continue
    stream.controller.abort()
    finish(stream, { code: "Unknown", message: "The extension host stopped" })
    streams.delete(key)
  }
  delivered.delete(pluginId)
}

function inertRegistration(kind: string) {
  return (payload: unknown, context: RpcContext) => {
    const value = owned(payload, context)
    const name = typeof value.name === "string" ? value.name : String(value.id ?? "")
    log(
      context.pluginId,
      "warn",
      `lm.${kind}("${name}"): Cognia does not use language model ${
        kind === "registerTool"
          ? "tools from extensions, so this tool is never called"
          : kind === "registerChatModelProvider"
            ? "providers from extensions, so this model is never offered"
            : "MCP server definitions from extensions, so these servers are never started"
      }`
    )
    return { registered: false }
  }
}

export function installVscodeLmHandlers(): Array<() => void> {
  return [
    registerMethod("lm:selectChatModels", (payload, context) => {
      const value = owned(payload, context)
      const selector =
        value.selector && typeof value.selector === "object" ? object(value.selector) : {}
      const models = modelsFor(context.pluginId)
      delivered.set(context.pluginId, JSON.stringify(models))
      return models.filter(
        (model) =>
          (selector.vendor === undefined || selector.vendor === model.vendor) &&
          (selector.family === undefined || selector.family === model.family) &&
          (selector.version === undefined || selector.version === model.version) &&
          (selector.id === undefined || selector.id === model.id)
      )
    }),
    registerMethod("lm:sendChatRequest", sendChatRequest),
    registerMethod("lm:readChatResponse", readChatResponse),
    registerMethod("lm:cancelChatRequest", cancelChatRequest),
    registerMethod("lm:countTokens", (payload, context) => {
      const value = owned(payload, context)
      const text = value.text
      if (typeof text !== "string") throw new Error("lm:countTokens requires text")
      return requireDeps().countTokens(text)
    }),
    registerMethod("lm:registerTool", inertRegistration("registerTool")),
    registerMethod("lm:registerChatModelProvider", inertRegistration("registerChatModelProvider")),
    registerMethod(
      "lm:registerMcpServerDefinitionProvider",
      inertRegistration("registerMcpServerDefinitionProvider")
    ),
  ]
}

/** Test-only: forget every request and dependency. */
export function __resetVscodeLmForTesting(): void {
  configureVscodeLm(null)
  for (const stream of streams.values()) stream.controller.abort()
  streams.clear()
}
