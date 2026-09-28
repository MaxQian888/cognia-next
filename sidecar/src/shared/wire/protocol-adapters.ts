// Shared contracts for outbound protocol adapters. An adapter turns a
// normalized request into a stream of AI-SDK-fullStream-shaped events — the
// single normalizer downstream (`event-adapter.mjs`) stays untouched no
// matter which wire protocol served the turn.
//
// The renderer's `types/plugin/plugin-protocol-adapter.ts` mirrors the
// declarative spec shape; a Jest parity test guards the two against drift.

export interface AdapterCredentials {
  apiKey?: string
  baseURL?: string
  /** Resolved protocol id (builtin or `${pluginId}:${id}`). */
  protocol?: string
  /** Extra default headers (Codex ChatGPT-login extras). */
  headers?: Record<string, string>
  /** Explicit OpenAI endpoint family. */
  apiFlavor?: "auto" | "responses" | "chat"
  bedrockAuthMode?: "api-key" | "iam" | "default-chain"
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  roleArn?: string
  roleSessionName?: string
}

/** Reasoning controls: an effort "thinking level" and/or a token budget. */
export interface ReasoningControls {
  effort?: string
  maxThinkingTokens?: number
}

/** A conversation message as the adapters forward it. */
export interface AdapterMessage {
  role: string
  content: unknown
  providerOptions?: unknown
}

/**
 * Canonical cross-runtime AI telemetry correlation fields. Mirrors
 * `CogniaAiTelemetryContext` in `packages/agent-trace/src/types.ts`, which the
 * sidecar cannot import.
 */
export interface AdapterTelemetryContext {
  sessionId?: string
  traceId?: string
  traceparent?: string
  surface?: string
  runId?: string
  turnId?: string
  attemptId?: string
  projectId?: string
  feature?: string
  promptComponentIds?: string[]
  promptVersion?: string
  promptFingerprint?: string
}

export interface NormalizedRequest extends AdapterTelemetryContext {
  /** Concrete model id for the upstream. */
  model: string
  /**
   * Built-in provider id (NOT the protocol); keys the OpenAI
   * responses-vs-chat decision and Codex's Responses-API fields.
   */
  providerId?: string
  messages: AdapterMessage[]
  /** AI SDK call-option names. */
  modelParams?: Record<string, unknown>
  /** Native AI SDK tools (declarative adapters ignore them; a documented v1 gap). */
  tools?: Record<string, unknown>
  /** Agentic step cap when tools are present. */
  maxSteps?: number
  /** Ends a leg early after a given step (see ai-sdk-adapter's `stopWhen`). */
  stopWhenExtra?: (steps: unknown) => boolean
  /** AI SDK per-step settings callback (e.g. activeTools). */
  prepareStep?: unknown
  /** Set only for a ledger-reserved call: one reservation, one request. */
  maxRetries?: number
  reasoning?: ReasoningControls
  credentials?: AdapterCredentials
  abortSignal?: AbortSignal
  /** Injected `streamText` (tests). */
  streamTextFn?: (args: Record<string, unknown>) => unknown
  /** Injected `fetch` (tests; declarative adapters). */
  fetchFn?: FetchLike
}

/** The response members a declarative adapter reads. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  headers?: { get?(name: string): string | null }
  text(): Promise<string>
  body: AsyncIterable<Uint8Array> | null
}

/** The slice of `fetch` a declarative adapter calls; the real `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal | undefined
  }
) => Promise<FetchResponseLike>

/** Usage an adapter reports after its stream ends (AI SDK camelCase names). */
export interface AdapterUsage {
  promptTokens?: number
  completionTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  [field: string]: unknown
}

export interface AdapterResult {
  /**
   * AI-SDK-fullStream-shaped events: `{type:"text-delta", text}` /
   * `{type:"reasoning-delta", text}` / `{type:"tool-call", ...}` /
   * `{type:"tool-result", ...}` / `{type:"finish", finishReason, usage}` —
   * exactly what `event-adapter.mjs` consumes.
   */
  fullStream: AsyncIterable<unknown>
  /** Resolves after the stream ends; null when the stream never finished. */
  usage?: PromiseLike<unknown>
  /** Full model messages for multi-turn history (ai-sdk only). */
  response?: PromiseLike<{ messages?: unknown[] }> | null
  responseMessages?: unknown
  steps?: unknown
}

export interface ProtocolAdapter {
  id: string
  start(req: NormalizedRequest): Promise<AdapterResult>
}

/** JSON paths into one streamed response chunk. */
export interface VariantResponsePaths {
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

/** A declarative `openai-compatible-variant` spec, contributed by a plugin as data. */
export interface OpenAiCompatibleVariantSpec {
  kind: "openai-compatible-variant"
  /** `{apiKey}` / `{model}` / `{baseURL}` placeholders are interpolated. */
  urlTemplate: string
  headers?: Record<string, string>
  requestRenames?: Record<string, string>
  requestInject?: Record<string, unknown>
  /** Wire field that carries the reasoning effort; omitted means never sent. */
  reasoningEffortField?: string
  reasoningEffortMap?: Record<string, string>
  responsePaths: VariantResponsePaths
}

/** A code-level adapter: plugin code the renderer runs on the sidecar's behalf. */
export interface CodeAdapterSpec {
  kind: "code"
  pluginId: string
  adapterId: string
}
