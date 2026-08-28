/**
 * Host runtime resolution for plugin APIs — the seam that answers "which
 * provider, which key, which search policy does THIS call bill?".
 *
 * Host-private on purpose: nothing here is re-exported through
 * `@cognia/plugin-sdk`. Plugins see only the public `ctx.ai.*` /
 * `ctx.agent.invokeTool` surface; this module decides who serves it.
 *
 * Two shapes of host exist and they resolve differently:
 *
 *  - **Ambient** (renderer, Tauri, Capacitor). One user, one hydrated settings
 *    store, one set of provider credentials. Every call can read the same
 *    ambient state, so a session id is optional.
 *  - **Session-scoped** (CLI / headless). Several sessions run concurrently in
 *    ONE process, each with its own resolved config, provider and API key, and
 *    the Zustand stores are never hydrated there. A call therefore MUST name
 *    its session, and a call that doesn't — or that names a session with no
 *    registered binding — fails closed. Falling back to the ambient reader
 *    would read an empty store and, worse, could bill the wrong session.
 *
 * This is the generalization of the Deep Research-specific `aiBridge` /
 * `webToolDeps` injection that used to be threaded through
 * `PluginToolContext.hostContext` for one hard-coded tool name. Every plugin
 * now gets the same wiring, and the host no longer special-cases a plugin by
 * name.
 */

import type { AIChatChunk, AIChatMessage, AIChatOptions, AIEmbedOptions } from "@/types/plugin"
import type { PluginAuthorCallableHostTool } from "@/types/plugin/plugin-host-tools"

import { createRendererHostRuntime } from "./renderer-host-runtime"

/** Who is asking, and on whose behalf. */
export interface PluginHostRuntimeRequest {
  /** The plugin making the call — used for attribution and rate-limit scoping. */
  pluginId: string
  /** Session the call belongs to. Required on session-scoped hosts. */
  sessionId?: string
  /** Message the call belongs to, when inside a turn. */
  messageId?: string
}

/** Everything a plugin API needs from the surrounding host. */
export interface PluginHostRuntime {
  /**
   * Execute one author-callable host tool. Implementations own the search /
   * fetch policy (providers, cache, source verification, SSRF, rate limit);
   * the caller only supplies arguments.
   */
  runHostTool: (
    name: PluginAuthorCallableHostTool,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>
  /**
   * Stream a chat completion. The PII gate runs in the API layer BEFORE this
   * is reached, so an implementation must never be the only thing standing
   * between plugin text and a provider.
   */
  chat: (messages: AIChatMessage[], options?: AIChatOptions) => AsyncIterable<AIChatChunk>
  /** Embed texts with this host's configured embedding provider. */
  embed: (texts: string[], options?: AIEmbedOptions) => Promise<number[][]>
  /** Provider id this host would use by default. */
  getDefaultProvider: () => string
  /** Model id this host would use by default. */
  getDefaultModel: () => string
}

/**
 * Factories are SYNCHRONOUS on purpose. Some plugin APIs that need a runtime
 * are synchronous themselves (`ctx.ai.getDefaultModel`), and an async resolver
 * would force either an await they cannot perform or a second, drifting sync
 * path. Anything genuinely async belongs inside the runtime's own async
 * methods — `runHostTool` already resolves its web deps there.
 */
export type PluginHostRuntimeFactory = (request: PluginHostRuntimeRequest) => PluginHostRuntime

/**
 * Raised when a session-scoped host cannot bind a call to a session. Callers
 * surface it as a structured "no provider" condition rather than letting a raw
 * throw escape mid-run.
 */
export class PluginHostRuntimeUnavailableError extends Error {
  readonly pluginId: string
  readonly sessionId: string | undefined

  constructor(request: PluginHostRuntimeRequest, detail: string) {
    super(
      `no host runtime for plugin ${request.pluginId}` +
        (request.sessionId ? ` in session ${request.sessionId}` : " (no session id)") +
        `: ${detail}`
    )
    this.name = "PluginHostRuntimeUnavailableError"
    this.pluginId = request.pluginId
    this.sessionId = request.sessionId
  }
}

const sessionFactories = new Map<string, PluginHostRuntimeFactory>()
let ambientFactory: PluginHostRuntimeFactory | null = null
let ambientEnabled = true

/**
 * Bind a session to its own runtime. Returns a disposer; call it (or
 * {@link clearSessionHostRuntime}) when the session closes, or the next session
 * that reuses the id inherits stale credentials.
 */
export function registerSessionHostRuntime(
  sessionId: string,
  factory: PluginHostRuntimeFactory
): () => void {
  if (!sessionId) return () => {}
  sessionFactories.set(sessionId, factory)
  return () => {
    // Only drop OUR binding: a re-registration for the same id (session
    // restart) must not be erased by the previous disposer firing late.
    if (sessionFactories.get(sessionId) === factory) sessionFactories.delete(sessionId)
  }
}

/** Drop a session's binding unconditionally. */
export function clearSessionHostRuntime(sessionId: string): void {
  sessionFactories.delete(sessionId)
}

/** Is a runtime currently bound to this session? */
export function hasSessionHostRuntime(sessionId: string): boolean {
  return sessionFactories.has(sessionId)
}

/**
 * Install the host's ambient runtime (renderer / Tauri / mobile). Passing
 * `null` restores the built-in lazy renderer factory.
 */
export function setAmbientHostRuntime(factory: PluginHostRuntimeFactory | null): void {
  ambientFactory = factory
}

/**
 * Turn a process into a session-scoped host: after this, a call with no bound
 * session throws instead of reading ambient state. The CLI calls it once at
 * startup. Idempotent.
 */
export function disableAmbientHostRuntime(): void {
  ambientEnabled = false
}

/** Restore ambient resolution. Test-only / host-shutdown seam. */
export function enableAmbientHostRuntime(): void {
  ambientEnabled = true
}

/** Test-only: wipe every binding and restore the default ambient factory. */
export function __resetPluginHostRuntimesForTesting(): void {
  sessionFactories.clear()
  ambientFactory = null
  ambientEnabled = true
}

/**
 * Resolve the runtime that should answer this call.
 *
 * Order: the session's own binding first (it is the most specific and the only
 * correct answer on a multi-session host), then the ambient one. A
 * session-scoped host with no binding fails closed.
 *
 * @throws {PluginHostRuntimeUnavailableError} on a session-scoped host when the
 * call names no session, or names one with no binding.
 */
export function resolvePluginHostRuntime(request: PluginHostRuntimeRequest): PluginHostRuntime {
  if (request.sessionId) {
    const bound = sessionFactories.get(request.sessionId)
    if (bound) return bound(request)
  }
  if (!ambientEnabled) {
    throw new PluginHostRuntimeUnavailableError(
      request,
      request.sessionId
        ? "this host resolves runtimes per session and that session is not bound"
        : "this host resolves runtimes per session — pass `sessionId` through to the API call"
    )
  }
  return (ambientFactory ?? createRendererHostRuntime)(request)
}
