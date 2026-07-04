/**
 * Plugin-contributed outbound protocol adapters
 * (`manifest.protocolAdapters`) — declarative DATA, not code. A plugin
 * describes an OpenAI-compatible-variant upstream as a pure-JSON spec; the
 * renderer forwards the spec to the sidecar via
 * `sendOptions.protocolAdapterSpec` and the sidecar's
 * `protocol-adapters/openai-compatible-variant-adapter.mjs` executes it
 * with fetch + an SSE parser. No plugin code ever loads into the sidecar
 * process (it holds full Node privileges and the user's API keys).
 *
 * The registered protocol id is namespaced as `${pluginId}:${id}`; custom
 * providers reference it via `CustomProviderSettings.apiProtocol`.
 *
 * The spec shape is mirrored by the sidecar (JSDoc) — a Jest parity test
 * (`lib/ai/providers/protocol-adapter-spec.parity.test.ts`) guards drift.
 */

/** Response-extraction JSON paths (dot segments + numeric brackets only). */
export interface OpenAiCompatibleVariantResponsePaths {
  /** Path to the text delta in each SSE chunk, e.g. `choices[0].delta.content`. */
  textDelta: string
  /** Path to a reasoning/thinking delta, when the upstream streams one. */
  reasoningDelta?: string
  /** Path to the finish reason, e.g. `choices[0].finish_reason`. */
  finishReason?: string
  /** Paths to token usage counters (usually on the final chunk). */
  usage?: {
    input?: string
    output?: string
    cacheRead?: string
    cacheCreation?: string
    reasoning?: string
  }
}

/**
 * Declarative description of an OpenAI-compatible-variant upstream.
 * `{apiKey}` / `{model}` / `{baseURL}` placeholders interpolate in
 * `urlTemplate` and header values.
 */
export interface OpenAiCompatibleVariantSpec {
  kind: "openai-compatible-variant"
  /** e.g. `{baseURL}/v1/chat/completions`. */
  urlTemplate: string
  /** Extra/override request headers (values may interpolate `{apiKey}`). */
  headers?: Record<string, string>
  /** Rename AI-SDK param names to wire names (e.g. maxOutputTokens → max_tokens). */
  requestRenames?: Record<string, string>
  /** Static fields merged into the request body (e.g. stream_options). */
  requestInject?: Record<string, unknown>
  responsePaths: OpenAiCompatibleVariantResponsePaths
}

/**
 * Code-level adapter spec (P2-E). For upstreams the declarative variant can't
 * express, the plugin ships REAL code that runs in the RENDERER (where plugin
 * code legitimately executes) and round-trips chunks to the sidecar. The
 * `entry`/`export` live renderer-side; only `{kind:"code", pluginId,
 * adapterId}` is forwarded to the sidecar (which never loads plugin code).
 */
export interface CodeProtocolAdapterSpec {
  kind: "code"
}

export type ProtocolAdapterSpec = OpenAiCompatibleVariantSpec | CodeProtocolAdapterSpec

/** What a code adapter forwards to the sidecar (no entry/export). */
export interface SidecarCodeAdapterSpec {
  kind: "code"
  pluginId: string
  adapterId: string
}

/** Normalized request a code executor receives (mirrors the sidecar shape). */
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
  | CodeAdapterFullStreamToolApprovalRequestChunk
  | CodeAdapterUiToolApprovalRequestChunk

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

/** AI-SDK-fullStream-shaped chunk a code executor yields. */
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
  | { type: string; [k: string]: unknown }

/** A plugin's code adapter: yields chunks for one turn. MUST NOT throw the
 *  whole stream — yield a `{type:"error"}` chunk to fail gracefully. */
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

/** One protocol-adapter contribution (declarative variant OR code). */
export interface PluginProtocolAdapterDef {
  /** Protocol id (namespaced to `${pluginId}:${id}` at registration). */
  id: string
  /** Human-readable label for the custom-provider protocol picker. */
  label: string
  description?: string
  /** Declarative execution spec (variant) or `{kind:"code"}` marker. */
  spec: ProtocolAdapterSpec
  /** Relative module path (lazy-imported on enable) — REQUIRED for code. */
  entry?: string
  /** Export name of the {@link CodeProtocolAdapterFactory} in `entry`. */
  export?: string
}
