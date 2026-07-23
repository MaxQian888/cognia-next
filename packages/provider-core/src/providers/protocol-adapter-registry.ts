/**
 * Renderer-side registry of plugin-contributed protocol adapters
 * (declarative `openai-compatible-variant` specs — see
 * `types/plugin/plugin-protocol-adapter.ts`). `build-options` consults it to
 * forward the spec to the sidecar; the custom-provider protocol picker lists
 * it alongside the built-ins.
 *
 * Built-in protocol ids (both the renderer's `gemini` naming and the
 * sidecar's `google`/`mistral`/`cohere` family names) are refused so a
 * plugin can never shadow a native execution path.
 */

import { BUILTIN_PROTOCOL_NAMES } from "../../../../sidecar/dispatch/protocol-adapters/provider-protocol.mjs"

export interface OpenAiCompatibleVariantResponsePaths {
  textDelta: string
  reasoningDelta?: string
  finishReason?: string
  usage?: {
    input?: string
    output?: string
    cacheRead?: string
    cacheCreation?: string
    reasoning?: string
  }
}

export interface OpenAiCompatibleVariantSpec {
  kind: "openai-compatible-variant"
  urlTemplate: string
  headers?: Record<string, string>
  requestRenames?: Record<string, string>
  requestInject?: Record<string, unknown>
  responsePaths: OpenAiCompatibleVariantResponsePaths
}

export interface CodeProtocolAdapterSpec {
  kind: "code"
}

export type ProtocolAdapterSpec = OpenAiCompatibleVariantSpec | CodeProtocolAdapterSpec

export interface SidecarCodeAdapterSpec {
  kind: "code"
  pluginId: string
  adapterId: string
}

export interface CodeAdapterRequest {
  model: string
  messages: Array<{ role: string; content: unknown; providerOptions?: unknown }>
  modelParams: Record<string, unknown>
  credentials: {
    apiKey?: string
    baseURL?: string
    protocol?: string
    apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
    headers?: Record<string, string>
  }
  reasoning?: { effort?: string; maxThinkingTokens?: number }
  maxSteps?: number
  abortSignal?: AbortSignal
}

export interface CodeAdapterUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  [key: string]: number | Record<string, number | undefined> | undefined
}

export type CodeAdapterProviderMetadata = Record<string, Record<string, unknown>>
export type CodeAdapterToolMetadata = Record<string, unknown>

export interface CodeAdapterStartChunk {
  type: "start"
  messageId?: string
  messageMetadata?: unknown
}

export interface CodeAdapterMessageMetadataChunk {
  type: "message-metadata"
  messageMetadata: unknown
}

export interface CodeAdapterTextStartChunk {
  type: "text-start"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterTextEndChunk {
  type: "text-end"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterTextDeltaChunk {
  type: "text-delta"
  id?: string
  text: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterReasoningStartChunk {
  type: "reasoning-start"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterReasoningEndChunk {
  type: "reasoning-end"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterReasoningDeltaChunk {
  type: "reasoning-delta"
  id?: string
  text: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterToolCallChunk {
  type: "tool-call"
  toolCallId: string
  toolName: string
  args?: unknown
  input?: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  title?: string
  invalid?: boolean
  error?: unknown
}

export interface CodeAdapterFullStreamToolApprovalRequestChunk {
  type: "tool-approval-request"
  approvalId: string
  signature?: string
  toolCall: CodeAdapterToolCallChunk
}

export interface CodeAdapterUiToolApprovalRequestChunk {
  type: "tool-approval-request"
  approvalId: string
  toolCallId: string
  signature?: string
}

export type CodeAdapterToolApprovalRequestChunk =
  CodeAdapterFullStreamToolApprovalRequestChunk | CodeAdapterUiToolApprovalRequestChunk

export interface CodeAdapterToolResultChunk {
  type: "tool-result"
  toolCallId: string
  toolName?: string
  input?: unknown
  output?: unknown
  result?: unknown
  isError?: boolean
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  preliminary?: boolean
  title?: string
}

export interface CodeAdapterToolErrorChunk {
  type: "tool-error"
  toolCallId: string
  toolName?: string
  input?: unknown
  error: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  title?: string
}

export interface CodeAdapterToolInputAvailableChunk {
  type: "tool-input-available"
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  title?: string
}

export interface CodeAdapterToolInputErrorChunk {
  type: "tool-input-error"
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  errorText: string
  title?: string
}

export interface CodeAdapterToolOutputAvailableChunk {
  type: "tool-output-available"
  toolCallId: string
  output: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  preliminary?: boolean
}

export interface CodeAdapterToolOutputErrorChunk {
  type: "tool-output-error"
  toolCallId: string
  errorText: string
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
}

export interface CodeAdapterStartStepChunk {
  type: "start-step"
  request?: unknown
  warnings?: unknown[]
}

export interface CodeAdapterFinishStepChunk {
  type: "finish-step"
  usage?: CodeAdapterUsage
  finishReason?: string
  rawFinishReason?: string
  response?: unknown
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterAbortChunk {
  type: "abort"
  reason?: string
}

export interface CodeAdapterRawChunk {
  /** Raw AI SDK provider frame. Accepted for type parity, not rendered or persisted by chat mappers. */
  type: "raw"
  rawValue: unknown
}

export interface CodeAdapterFinishChunk {
  type: "finish"
  finishReason?: string
  usage?: CodeAdapterUsage
  totalUsage?: CodeAdapterUsage
  messageMetadata?: unknown
}

export interface CodeAdapterGeneratedFileChunk {
  type: "file"
  file: { base64: string; mediaType: string }
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterUrlFileChunk {
  type: "file"
  url: string
  mediaType: string
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterSourceUrlChunk {
  type: "source-url"
  sourceId: string
  url: string
  title?: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export interface CodeAdapterSourceDocumentChunk {
  type: "source-document"
  sourceId: string
  mediaType: string
  title: string
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}

export type CodeAdapterChunk =
  | CodeAdapterStartChunk
  | CodeAdapterTextStartChunk
  | CodeAdapterTextEndChunk
  | CodeAdapterTextDeltaChunk
  | CodeAdapterReasoningStartChunk
  | CodeAdapterReasoningEndChunk
  | CodeAdapterReasoningDeltaChunk
  | {
      type: "tool-input-start"
      id: string
      toolName: string
      providerExecuted?: boolean
      providerMetadata?: CodeAdapterProviderMetadata
      toolMetadata?: CodeAdapterToolMetadata
      dynamic?: boolean
      title?: string
    }
  | {
      type: "tool-input-start"
      toolCallId: string
      toolName: string
      providerExecuted?: boolean
      providerMetadata?: CodeAdapterProviderMetadata
      toolMetadata?: CodeAdapterToolMetadata
      dynamic?: boolean
      title?: string
    }
  | {
      type: "tool-input-delta"
      id: string
      delta: string
      providerMetadata?: CodeAdapterProviderMetadata
    }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-end"; id: string; providerMetadata?: CodeAdapterProviderMetadata }
  | CodeAdapterToolCallChunk
  | CodeAdapterToolResultChunk
  | CodeAdapterToolErrorChunk
  | CodeAdapterToolApprovalRequestChunk
  | CodeAdapterToolInputAvailableChunk
  | CodeAdapterToolInputErrorChunk
  | CodeAdapterToolOutputAvailableChunk
  | CodeAdapterToolOutputErrorChunk
  | CodeAdapterStartStepChunk
  | CodeAdapterFinishStepChunk
  | CodeAdapterAbortChunk
  | CodeAdapterRawChunk
  | CodeAdapterMessageMetadataChunk
  | {
      type: "tool-output-denied"
      toolCallId: string
      toolName?: string
      providerExecuted?: boolean
      dynamic?: false
    }
  | CodeAdapterGeneratedFileChunk
  | CodeAdapterUrlFileChunk
  | CodeAdapterSourceUrlChunk
  | CodeAdapterSourceDocumentChunk
  | {
      type: "source"
      sourceType?: "url" | "document"
      url?: string
      title?: string
      filename?: string
    }
  | { type: "error"; error: unknown }
  | CodeAdapterFinishChunk
  | { type: string; [key: string]: unknown }

export interface CodeProtocolAdapterLike {
  stream: (req: CodeAdapterRequest) => AsyncIterable<CodeAdapterChunk>
}

export interface CodeProtocolAdapterContext {
  adapterId: string
  pluginId: string
}

export type CodeProtocolAdapterFactory = (
  ctx: CodeProtocolAdapterContext
) => CodeProtocolAdapterLike | Promise<CodeProtocolAdapterLike>

export interface PluginProtocolAdapterDef {
  id: string
  label: string
  description?: string
  spec: ProtocolAdapterSpec
  entry?: string
  export?: string
}

interface OverlayRegistry<T> {
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string } | undefined
  unregisterById(id: string): boolean
  unregisterByPlugin(pluginId: string): number
  get(id: string): T | undefined
  entries(): Array<{ id: string; entry: T; pluginId?: string }>
  __resetForTesting(): void
}

function createOverlayRegistry<T>(options?: {
  name?: string
  conflictPolicy?: "last-wins" | "first-wins-cross-plugin"
}): OverlayRegistry<T> {
  const store = new Map<string, { entry: T; pluginId?: string }>()
  const conflictPolicy = options?.conflictPolicy ?? "last-wins"

  return {
    register(id, entry, opts) {
      const previous = store.get(id)
      if (
        previous &&
        conflictPolicy === "first-wins-cross-plugin" &&
        previous.pluginId !== opts?.pluginId
      ) {
        return previous
      }
      store.set(id, { entry, pluginId: opts?.pluginId })
      return previous
    },
    unregisterById(id) {
      return store.delete(id)
    },
    unregisterByPlugin(pluginId) {
      let removed = 0
      for (const [id, value] of store) {
        if (value.pluginId === pluginId) {
          store.delete(id)
          removed += 1
        }
      }
      return removed
    },
    get(id) {
      return store.get(id)?.entry
    },
    entries() {
      return Array.from(store, ([id, value]) => ({ id, ...value }))
    },
    __resetForTesting() {
      store.clear()
    },
  }
}

/** Renderer built-ins ∪ sidecar family names — ids a plugin may not claim. */
const RESERVED_PROTOCOL_IDS: ReadonlySet<string> = new Set([...BUILTIN_PROTOCOL_NAMES, "gemini"])

const overlay = createOverlayRegistry<PluginProtocolAdapterDef>({
  name: "protocol-adapters",
  conflictPolicy: "first-wins-cross-plugin",
})

/** Resolve a registered plugin protocol adapter by its (namespaced) id. */
export function getProtocolAdapter(id: string): PluginProtocolAdapterDef | undefined {
  return overlay.get(id)
}

/**
 * Register a plugin protocol adapter. Reserved/built-in ids are rejected
 * (returns false) so native protocols stay authoritative.
 */
export function registerProtocolAdapter(
  def: PluginProtocolAdapterDef,
  opts?: { pluginId?: string }
): boolean {
  if (RESERVED_PROTOCOL_IDS.has(def.id)) {
    return false
  }
  overlay.register(def.id, def, opts)
  return true
}

export function unregisterProtocolAdapter(id: string): boolean {
  return overlay.unregisterById(id)
}

export function unregisterProtocolAdaptersByPlugin(pluginId: string): number {
  return overlay.unregisterByPlugin(pluginId)
}

/** Every registered plugin protocol adapter (for the protocol picker). */
export function listProtocolAdapters(): Array<{
  id: string
  label: string
  pluginId?: string
}> {
  return overlay.entries().map(({ id, entry, pluginId }) => ({
    id,
    label: entry.label ?? id,
    pluginId,
  }))
}

// ---- Code-adapter executors (P2-E) -----------------------------------------
//
// Code adapters run their real fetch/transform/stream logic in the RENDERER.
// The bridge dynamic-imports the plugin's factory on enable and registers it
// here under the namespaced adapter id; the `protocol_adapter_exec` IPC pump
// resolves it per turn. Kept separate from the `def` overlay so the picker /
// build-options surface (which only needs the spec) stays code-free.

const codeExecutors = new Map<string, { factory: CodeProtocolAdapterFactory; pluginId?: string }>()

export function registerCodeAdapterExecutor(
  adapterId: string,
  factory: CodeProtocolAdapterFactory,
  pluginId?: string
): void {
  codeExecutors.set(adapterId, { factory, pluginId })
}

export function getCodeAdapterExecutor(adapterId: string): CodeProtocolAdapterFactory | undefined {
  return codeExecutors.get(adapterId)?.factory
}

/** Drop a single code-adapter executor by its (namespaced) adapter id. */
export function unregisterCodeAdapterExecutor(adapterId: string): boolean {
  return codeExecutors.delete(adapterId)
}

export function unregisterCodeAdapterExecutorsByPlugin(pluginId: string): number {
  let n = 0
  for (const [id, entry] of codeExecutors) {
    if (entry.pluginId === pluginId) {
      codeExecutors.delete(id)
      n++
    }
  }
  return n
}

/** Test-only: drop every registered adapter. */
export function __resetProtocolAdaptersForTesting(): void {
  overlay.__resetForTesting()
  codeExecutors.clear()
}
