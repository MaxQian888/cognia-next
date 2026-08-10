import * as _cognia_provider_types_provider from "@cognia/provider-types/provider"

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
interface OpenAiCompatibleVariantResponsePaths {
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
interface OpenAiCompatibleVariantSpec {
  kind: "openai-compatible-variant"
  urlTemplate: string
  headers?: Record<string, string>
  requestRenames?: Record<string, string>
  requestInject?: Record<string, unknown>
  responsePaths: OpenAiCompatibleVariantResponsePaths
}
interface CodeProtocolAdapterSpec {
  kind: "code"
}
type ProtocolAdapterSpec = OpenAiCompatibleVariantSpec | CodeProtocolAdapterSpec
interface SidecarCodeAdapterSpec {
  kind: "code"
  pluginId: string
  adapterId: string
}
interface CodeAdapterRequest {
  model: string
  messages: Array<{
    role: string
    content: unknown
    providerOptions?: unknown
  }>
  modelParams: Record<string, unknown>
  credentials: {
    apiKey?: string
    baseURL?: string
    protocol?: string
    apiFlavor?: _cognia_provider_types_provider.ApiFlavor
    headers?: Record<string, string>
  }
  reasoning?: {
    effort?: string
    maxThinkingTokens?: number
  }
  maxSteps?: number
  abortSignal?: AbortSignal
}
interface CodeAdapterUsage {
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
type CodeAdapterProviderMetadata = Record<string, Record<string, unknown>>
type CodeAdapterToolMetadata = Record<string, unknown>
interface CodeAdapterStartChunk {
  type: "start"
  messageId?: string
  messageMetadata?: unknown
}
interface CodeAdapterMessageMetadataChunk {
  type: "message-metadata"
  messageMetadata: unknown
}
interface CodeAdapterTextStartChunk {
  type: "text-start"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterTextEndChunk {
  type: "text-end"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterTextDeltaChunk {
  type: "text-delta"
  id?: string
  text: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterReasoningStartChunk {
  type: "reasoning-start"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterReasoningEndChunk {
  type: "reasoning-end"
  id: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterReasoningDeltaChunk {
  type: "reasoning-delta"
  id?: string
  text: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterToolCallChunk {
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
interface CodeAdapterFullStreamToolApprovalRequestChunk {
  type: "tool-approval-request"
  approvalId: string
  signature?: string
  toolCall: CodeAdapterToolCallChunk
}
interface CodeAdapterUiToolApprovalRequestChunk {
  type: "tool-approval-request"
  approvalId: string
  toolCallId: string
  signature?: string
}
type CodeAdapterToolApprovalRequestChunk =
  CodeAdapterFullStreamToolApprovalRequestChunk | CodeAdapterUiToolApprovalRequestChunk
interface CodeAdapterToolResultChunk {
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
interface CodeAdapterToolErrorChunk {
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
interface CodeAdapterToolInputAvailableChunk {
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
interface CodeAdapterToolInputErrorChunk {
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
interface CodeAdapterToolOutputAvailableChunk {
  type: "tool-output-available"
  toolCallId: string
  output: unknown
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
  preliminary?: boolean
}
interface CodeAdapterToolOutputErrorChunk {
  type: "tool-output-error"
  toolCallId: string
  errorText: string
  providerExecuted?: boolean
  providerMetadata?: CodeAdapterProviderMetadata
  toolMetadata?: CodeAdapterToolMetadata
  dynamic?: boolean
}
interface CodeAdapterStartStepChunk {
  type: "start-step"
  request?: unknown
  warnings?: unknown[]
}
interface CodeAdapterFinishStepChunk {
  type: "finish-step"
  usage?: CodeAdapterUsage
  finishReason?: string
  rawFinishReason?: string
  response?: unknown
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterAbortChunk {
  type: "abort"
  reason?: string
}
interface CodeAdapterRawChunk {
  /** Raw AI SDK provider frame. Accepted for type parity, not rendered or persisted by chat mappers. */
  type: "raw"
  rawValue: unknown
}
interface CodeAdapterFinishChunk {
  type: "finish"
  finishReason?: string
  usage?: CodeAdapterUsage
  totalUsage?: CodeAdapterUsage
  messageMetadata?: unknown
}
interface CodeAdapterGeneratedFileChunk {
  type: "file"
  file: {
    base64: string
    mediaType: string
  }
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterUrlFileChunk {
  type: "file"
  url: string
  mediaType: string
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterSourceUrlChunk {
  type: "source-url"
  sourceId: string
  url: string
  title?: string
  providerMetadata?: CodeAdapterProviderMetadata
}
interface CodeAdapterSourceDocumentChunk {
  type: "source-document"
  sourceId: string
  mediaType: string
  title: string
  filename?: string
  providerMetadata?: CodeAdapterProviderMetadata
}
type CodeAdapterChunk =
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
  | {
      type: "tool-input-delta"
      toolCallId: string
      inputTextDelta: string
    }
  | {
      type: "tool-input-end"
      id: string
      providerMetadata?: CodeAdapterProviderMetadata
    }
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
  | {
      type: "error"
      error: unknown
    }
  | CodeAdapterFinishChunk
  | {
      type: string
      [key: string]: unknown
    }
interface CodeProtocolAdapterLike {
  stream: (req: CodeAdapterRequest) => AsyncIterable<CodeAdapterChunk>
}
interface CodeProtocolAdapterContext {
  adapterId: string
  pluginId: string
}
type CodeProtocolAdapterFactory = (
  ctx: CodeProtocolAdapterContext
) => CodeProtocolAdapterLike | Promise<CodeProtocolAdapterLike>
interface PluginProtocolAdapterDef {
  id: string
  label: string
  description?: string
  spec: ProtocolAdapterSpec
  entry?: string
  export?: string
}
/** Resolve a registered plugin protocol adapter by its (namespaced) id. */
declare function getProtocolAdapter(id: string): PluginProtocolAdapterDef | undefined
/**
 * Register a plugin protocol adapter. Reserved/built-in ids are rejected
 * (returns false) so native protocols stay authoritative.
 */
declare function registerProtocolAdapter(
  def: PluginProtocolAdapterDef,
  opts?: {
    pluginId?: string
  }
): boolean
declare function unregisterProtocolAdapter(id: string): boolean
declare function unregisterProtocolAdaptersByPlugin(pluginId: string): number
/** Every registered plugin protocol adapter (for the protocol picker). */
declare function listProtocolAdapters(): Array<{
  id: string
  label: string
  pluginId?: string
}>
declare function registerCodeAdapterExecutor(
  adapterId: string,
  factory: CodeProtocolAdapterFactory,
  pluginId?: string
): void
declare function getCodeAdapterExecutor(adapterId: string): CodeProtocolAdapterFactory | undefined
/** Drop a single code-adapter executor by its (namespaced) adapter id. */
declare function unregisterCodeAdapterExecutor(adapterId: string): boolean
declare function unregisterCodeAdapterExecutorsByPlugin(pluginId: string): number
/** Test-only: drop every registered adapter. */
declare function __resetProtocolAdaptersForTesting(): void

export {
  type CodeAdapterAbortChunk,
  type CodeAdapterChunk,
  type CodeAdapterFinishChunk,
  type CodeAdapterFinishStepChunk,
  type CodeAdapterFullStreamToolApprovalRequestChunk,
  type CodeAdapterGeneratedFileChunk,
  type CodeAdapterMessageMetadataChunk,
  type CodeAdapterProviderMetadata,
  type CodeAdapterRawChunk,
  type CodeAdapterReasoningDeltaChunk,
  type CodeAdapterReasoningEndChunk,
  type CodeAdapterReasoningStartChunk,
  type CodeAdapterRequest,
  type CodeAdapterSourceDocumentChunk,
  type CodeAdapterSourceUrlChunk,
  type CodeAdapterStartChunk,
  type CodeAdapterStartStepChunk,
  type CodeAdapterTextDeltaChunk,
  type CodeAdapterTextEndChunk,
  type CodeAdapterTextStartChunk,
  type CodeAdapterToolApprovalRequestChunk,
  type CodeAdapterToolCallChunk,
  type CodeAdapterToolErrorChunk,
  type CodeAdapterToolInputAvailableChunk,
  type CodeAdapterToolInputErrorChunk,
  type CodeAdapterToolMetadata,
  type CodeAdapterToolOutputAvailableChunk,
  type CodeAdapterToolOutputErrorChunk,
  type CodeAdapterToolResultChunk,
  type CodeAdapterUiToolApprovalRequestChunk,
  type CodeAdapterUrlFileChunk,
  type CodeAdapterUsage,
  type CodeProtocolAdapterContext,
  type CodeProtocolAdapterFactory,
  type CodeProtocolAdapterLike,
  type CodeProtocolAdapterSpec,
  type OpenAiCompatibleVariantResponsePaths,
  type OpenAiCompatibleVariantSpec,
  type PluginProtocolAdapterDef,
  type ProtocolAdapterSpec,
  type SidecarCodeAdapterSpec,
  __resetProtocolAdaptersForTesting,
  getCodeAdapterExecutor,
  getProtocolAdapter,
  listProtocolAdapters,
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutor,
  unregisterCodeAdapterExecutorsByPlugin,
  unregisterProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
}
