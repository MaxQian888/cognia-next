// Shared JSDoc contracts for outbound protocol adapters. An adapter turns a
// normalized request into a stream of AI-SDK-fullStream-shaped events — the
// single normalizer downstream (`event-adapter.mjs`) stays untouched no
// matter which wire protocol served the turn.
//
// This file is types-only (JSDoc; the sidecar has no TypeScript). The
// renderer's `types/plugin/plugin-protocol-adapter.ts` mirrors the
// declarative spec shape; a Jest parity test guards the two against drift.

/**
 * @typedef {Object} AdapterCredentials
 * @property {string} [apiKey]
 * @property {string} [baseURL]
 * @property {string} [protocol]  Resolved protocol id (builtin or `${pluginId}:${id}`).
 */

/**
 * @typedef {Object} NormalizedRequest
 * @property {string} model                       Concrete model id for the upstream.
 * @property {Array<{role: string, content: any, providerOptions?: any}>} messages
 * @property {Record<string, unknown>} [modelParams]  AI SDK v6 call-option names.
 * @property {Record<string, unknown>} [tools]    Native AI SDK tools (declarative adapters ignore; documented v1 gap).
 * @property {number} [maxSteps]                  Agentic step cap when tools are present.
 * @property {AdapterCredentials} [credentials]
 * @property {Function} [streamTextFn]            Injected `streamText` (tests).
 * @property {Function} [fetchFn]                 Injected `fetch` (tests; declarative adapters).
 */

/**
 * @typedef {Object} AdapterResult
 * @property {AsyncIterable<any>} fullStream      AI-SDK-fullStream-shaped events:
 *   `{type:"text-delta", text}` / `{type:"reasoning-delta", text}` /
 *   `{type:"tool-call", ...}` / `{type:"tool-result", ...}` /
 *   `{type:"finish", finishReason, usage}` — exactly what `event-adapter.mjs` consumes.
 * @property {Promise<any>} [usage]               Resolves `{promptTokens, completionTokens, ...}` after the stream ends.
 * @property {Promise<{messages?: any[]}>} [response]  Full model messages for multi-turn history (ai-sdk only).
 */

/**
 * @typedef {Object} ProtocolAdapter
 * @property {string} id
 * @property {(req: NormalizedRequest) => Promise<AdapterResult>} start
 */

export {}
