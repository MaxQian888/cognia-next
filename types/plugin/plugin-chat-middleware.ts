/**
 * Type contracts for plugin-contributed chat middleware.
 *
 * The middleware shell wraps `lib/claude/build-options.ts:resolveSendOptions`
 * + the actual claude-agent-sdk send call. Plugins register Koa-style
 * `(req, next) => Promise<Response>` functions that can inspect/transform
 * the outgoing request, short-circuit it, and post-process the response.
 *
 * Safety net (locked decision #10):
 *   - **Timeout** — `Promise.race` against a per-middleware deadline
 *     (default 5000 ms). On timeout the middleware is *skipped*; the chain
 *     proceeds with the previous middleware's output.
 *   - **Error isolation** — every middleware runs inside try/catch. Throws
 *     log + skip, never propagate to the main pipeline.
 *   - **Circuit breaker** — three consecutive (timeout OR throw) failures
 *     mark the middleware (and by extension the plugin) as `disabled`. The
 *     host posts a notification pointing at plugin settings; the counter
 *     resets on plugin re-enable.
 *
 * Plugins also get access to the lower-pressure `onBuildOptions` hook
 * (transform pipeline) when they only need to mutate the options dict and
 * don't need to short-circuit. See `lib/plugin/messaging/hooks-system.ts`.
 *
 * Permission gate: `chat:hooks` (closest existing key — verified against
 * `PluginPermission` union in plugin.ts). See ADR-0026 §4.
 */

import type { PluginContributionBackend } from "@/types/plugin/plugin"

import type { PluginMessage } from "./plugin"

/**
 * One middleware contribution in `manifest.chatMiddlewares[]`. Lazy factory
 * shape — `entry` is dynamic-imported only when the chat send call site
 * runs for the first time after plugin enable.
 */
export interface PluginChatMiddlewareDef {
  /**
   * Middleware id, unprefixed. The host prefixes with the plugin id at
   * registration time so two plugins cannot collide. The id is also the
   * key used by the circuit-breaker counter.
   */
  id: string
  /** Human label shown in plugin settings. */
  label: string
  /** Relative path inside the plugin install root. */
  /**
   * Which runtime owns this middleware. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  entry?: string
  /**
   * Named export on the entry module — must resolve to a
   * `ChatMiddleware` at runtime.
   */
  export?: string
  /**
   * Execution priority. Higher runs *outer* in the Koa-style chain (i.e.
   * sees the request first, sees the response last). Default 0; range
   * [-100, 100]. Two middlewares with the same priority sort by `(pluginId,
   * id)` lexicographically for deterministic order.
   */
  priority?: number
  /**
   * Per-middleware timeout in ms. Default 5000. Capped at 60000 by the
   * runner; manifest values above the cap are clamped + warned.
   */
  timeoutMs?: number
}

/**
 * The request object handed to a middleware. Wraps `SendOptions` from
 * `lib/claude/types` plus a few host-curated fields the middleware is
 * allowed to read. Middlewares mutate by returning a new object from
 * the wrapped `next()` chain, not by mutating in place.
 */
export interface ChatMiddlewareRequest {
  /**
   * Conversation messages, in send order. Same shape the plugin-tool MCP
   * bridge uses.
   */
  messages: PluginMessage[]
  /** Resolved model identifier (e.g. `"claude-opus-4-7"`). */
  model: string
  /** Session id this request belongs to. */
  sessionId: string
  /**
   * Plugin-readable subset of `SendOptions` — anything not in here is host
   * internal and not exposed to the middleware. The full options object is
   * mutated via the `onBuildOptions` hook, not via middleware.
   */
  options: {
    systemPrompt?: string
    appendSystemPrompt?: string
    maxTokens?: number
    temperature?: number
    /** Allow-list of tool names the agent may call. `undefined` means default. */
    allowedTools?: string[]
  }
  /** AbortSignal — fires when the user cancels the turn. */
  signal: AbortSignal
}

/**
 * Response object returned by the chain. Plugins can read but should
 * forward verbatim unless they specifically want to transform the
 * assistant turn (and that's better done via `onPostChatReceive` if the
 * change is content-only).
 */
export interface ChatMiddlewareResponse {
  /** Full assistant message text after all transformations. */
  text: string
  /** Optional token usage. */
  usage?: { prompt: number; completion: number; total: number }
  /** Set by the host when a downstream middleware short-circuited the chain. */
  shortCircuited?: boolean
}

export type ChatMiddlewareNext = () => Promise<ChatMiddlewareResponse>

export type ChatMiddleware = (
  req: ChatMiddlewareRequest,
  next: ChatMiddlewareNext
) => Promise<ChatMiddlewareResponse>

export interface PluginChatMiddlewareFactoryContext {
  middlewareId: string
  pluginId: string
  getConfig<T = unknown>(key: string): T | undefined
  getSecret(key: string): Promise<string | undefined>
}

export type PluginChatMiddlewareFactory = (
  ctx: PluginChatMiddlewareFactoryContext
) => ChatMiddleware | Promise<ChatMiddleware>

export interface PluginChatMiddlewareRegistration {
  middlewareId: string
  unregister(): void
}
