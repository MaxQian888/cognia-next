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
  | "invoke_agent"
  | "execute_tool"
  | "chat"
  | "invoke_workflow"
  | "retrieval"

/** OTel `gen_ai.provider.name` plus Cognia vendor extensions. */
export type SpanProviderName =
  | "anthropic"
  | "openai"
  | "cognia.plugin"
  | "cognia.team"
  | "cognia.connector"
  | "cognia.workflow"

/** Surface that produced the span. */
export type SpanSurface = "chat" | "agent-team" | "plugin-hook" | "connector" | "workflow"

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
