/**
 * Agent-trace public type contracts.
 *
 * These live inside the package so package-local typechecks do not need to
 * pull in the app-level `types/` or `lib/logging` trees.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface StructuredLogEntry {
  id: string
  timestamp: string
  level: LogLevel
  message: string
  module: string
  traceId?: string
  sessionId?: string
  data?: Record<string, unknown>
  tags?: string[]
}

/** Top-level OTel `gen_ai.operation.name`. */
export type SpanOperationName =
  "invoke_agent" | "execute_tool" | "chat" | "invoke_workflow" | "retrieval" | "embeddings"

/**
 * OTel `gen_ai.provider.name` well-known values, plus Cognia vendor extensions.
 *
 * Open on purpose: the semantic convention requires a well-known value when one
 * applies and permits a custom value otherwise, so an unrecognized provider id
 * is emitted verbatim rather than mislabelled. Use
 * `providerNameFromId()` from `./provider-name` to resolve one.
 */
export type SpanProviderName =
  // OTel GenAI well-known values.
  | "anthropic"
  | "aws.bedrock"
  | "azure.ai.inference"
  | "azure.ai.openai"
  | "cohere"
  | "deepseek"
  | "gcp.gemini"
  | "gcp.gen_ai"
  | "gcp.vertex_ai"
  | "groq"
  | "ibm.watsonx.ai"
  | "mistral_ai"
  | "openai"
  | "perplexity"
  | "x_ai"
  // Cognia vendor extensions — non-model surfaces that still emit spans.
  | "cognia.plugin"
  /** The settings.json lifecycle-hook runtime (`hook_audit` envelopes). */
  | "cognia.hook"
  | "cognia.team"
  | "cognia.connector"
  | "cognia.workflow"
  | "cognia.twin"
  // Any other provider id, carried verbatim as a spec-legal custom value.
  | (string & {})

/** Surface that produced the span. */
export type SpanSurface =
  | "chat"
  | "agent-team"
  | "plugin-hook"
  | "connector"
  | "workflow"
  // Surfaces that emit spans of their own rather than riding a chat turn.
  // `plugin-hook` stays the hook-GATE surface; `plugin` is direct plugin
  // execution (the WASM bridge).
  | "mcp"
  | "retrieval"
  | "embedding"
  | "plugin"

/** OTel span kind — `client`/`server` mark the two sides of a process hop. */
export type SpanKind = "internal" | "client" | "server"

/** Lifecycle state of a persisted span. */
export type SpanStatus = "pending" | "ok" | "error" | "incomplete"

export interface SpanEvent {
  name: string
  at: number
  attributes?: Record<string, unknown>
}

export interface SpanUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /**
   * Cache-write split by TTL. Both are subsets of `cacheCreationTokens` and are
   * present only when the provider reported the breakdown — a 1-hour write bills
   * at 2x base input against 1.25x for a 5-minute one, so collapsing them loses
   * the only signal that separates the two rates.
   */
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
}

export interface SpanHandoff {
  fromAgent: string
  toAgent: string
  reason?: string
}

export interface AgentTraceSpan {
  id: string
  projectId?: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startTime: number
  endTime?: number
  durationMs?: number
  operationName: SpanOperationName
  providerName: SpanProviderName
  requestModel?: string
  responseModel?: string
  agentId?: string
  agentName?: string
  toolName?: string
  usage?: SpanUsage
  costUsdEstimate?: number
  finishReasons?: string[]
  errorType?: string
  errorMessage?: string
  spanKind?: SpanKind
  status?: SpanStatus
  runId?: string
  turnId?: string
  attemptId?: string
  sessionId: string
  surface: SpanSurface
  pluginId?: string
  handoff?: SpanHandoff
  events?: SpanEvent[]
  inputPreview?: string
  outputPreview?: string
  metadata?: Record<string, unknown>
}

export const AGENT_TRACE_SPAN_KIND = "agent-trace-span" as const

export interface AgentTraceSpanLogPayload {
  kind: typeof AGENT_TRACE_SPAN_KIND
  span: AgentTraceSpan
}
