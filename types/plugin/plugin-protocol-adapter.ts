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

/** One declarative protocol-adapter contribution. */
export interface PluginProtocolAdapterDef {
  /** Protocol id (namespaced to `${pluginId}:${id}` at registration). */
  id: string
  /** Human-readable label for the custom-provider protocol picker. */
  label: string
  description?: string
  /** The declarative execution spec forwarded to the sidecar. */
  spec: OpenAiCompatibleVariantSpec
}
