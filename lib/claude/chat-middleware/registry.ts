/**
 * Chat-middleware registry.
 *
 * Holds the ordered list of around-style middlewares registered through
 * `ctx.chat.use(...)` (Phase 4 §A of ADR-0026). Each entry tracks:
 *   - the owning plugin id (for circuit-breaker bookkeeping + cleanup),
 *   - the middleware id (unprefixed, used as the breaker key),
 *   - the function itself,
 *   - the per-middleware timeout (default 5000 ms, clamped to ≤ 60000),
 *   - priority (higher runs outer in the chain),
 *   - the current consecutive-failure counter (reset on success),
 *   - a `disabled` flag the runner consults on each turn (set true once
 *     the breaker trips).
 *
 * Mutations notify listeners so settings UIs can render the disabled
 * banner without polling. ADR-0026 §4 §A circuit-breaker semantics:
 * three consecutive failures (timeout OR throw) → set `disabled=true` and
 * fire a `breaker-tripped` event. Plugin disable + re-enable resets the
 * counter via `clearChatMiddlewaresForPlugin(pluginId)`.
 */

import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"

export const DEFAULT_MIDDLEWARE_TIMEOUT_MS = 5_000
export const MAX_MIDDLEWARE_TIMEOUT_MS = 60_000
export const CIRCUIT_BREAKER_THRESHOLD = 3

export interface ChatMiddlewareRegistration {
  pluginId: string
  /** Unprefixed middleware id; key for the breaker counter. */
  middlewareId: string
  /** Full id used in logs (`<pluginId>:<middlewareId>`). */
  fullId: string
  fn: ChatMiddleware
  priority: number
  timeoutMs: number
  consecutiveFailures: number
  disabled: boolean
  /** True once the breaker has tripped — surfaced to settings UI. */
  breakerTripped: boolean
}

export type ChatMiddlewareEvent =
  | { type: "registered"; fullId: string; pluginId: string }
  | { type: "unregistered"; fullId: string; pluginId: string }
  | { type: "breaker-tripped"; fullId: string; pluginId: string; reason: string }
  | { type: "breaker-reset"; fullId: string; pluginId: string }

const registry = new Map<string, ChatMiddlewareRegistration>()
const listeners = new Set<(event: ChatMiddlewareEvent) => void>()

function emit(event: ChatMiddlewareEvent): void {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch (err) {
      // Listeners must not throw across the registry boundary.

      console.warn("[chat-middleware] listener threw:", err)
    }
  }
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MIDDLEWARE_TIMEOUT_MS
  }
  return Math.min(value, MAX_MIDDLEWARE_TIMEOUT_MS)
}

export interface RegisterChatMiddlewareArgs {
  pluginId: string
  middlewareId: string
  fn: ChatMiddleware
  priority?: number
  timeoutMs?: number
}

export function registerChatMiddleware(args: RegisterChatMiddlewareArgs): () => void {
  const fullId = `${args.pluginId}:${args.middlewareId}`
  if (registry.has(fullId)) {
    throw new Error(
      `[chat-middleware] plugin ${args.pluginId} already registered middleware "${args.middlewareId}"`
    )
  }
  registry.set(fullId, {
    pluginId: args.pluginId,
    middlewareId: args.middlewareId,
    fullId,
    fn: args.fn,
    priority: args.priority ?? 0,
    timeoutMs: clampTimeout(args.timeoutMs),
    consecutiveFailures: 0,
    disabled: false,
    breakerTripped: false,
  })
  emit({ type: "registered", fullId, pluginId: args.pluginId })
  return () => unregisterChatMiddleware(fullId)
}

export function unregisterChatMiddleware(fullId: string): boolean {
  const entry = registry.get(fullId)
  if (!entry) return false
  registry.delete(fullId)
  emit({ type: "unregistered", fullId, pluginId: entry.pluginId })
  return true
}

/**
 * Drop every middleware owned by the given plugin id. Called on plugin
 * disable / unload.
 */
export function clearChatMiddlewaresForPlugin(pluginId: string): void {
  const toDrop: string[] = []
  for (const [id, entry] of registry) {
    if (entry.pluginId === pluginId) toDrop.push(id)
  }
  for (const id of toDrop) unregisterChatMiddleware(id)
}

/**
 * Snapshot of the active middleware chain, sorted by priority desc then
 * (pluginId, middlewareId) for deterministic order. Disabled middlewares
 * are excluded — they are skipped silently.
 */
export function listActiveChatMiddlewares(): ChatMiddlewareRegistration[] {
  return Array.from(registry.values())
    .filter((m) => !m.disabled)
    .sort((a, b) => {
      const pd = b.priority - a.priority
      if (pd !== 0) return pd
      const ap = `${a.pluginId}:${a.middlewareId}`
      const bp = `${b.pluginId}:${b.middlewareId}`
      return ap.localeCompare(bp)
    })
}

export function listAllChatMiddlewares(): ChatMiddlewareRegistration[] {
  return Array.from(registry.values())
}

export function getChatMiddleware(fullId: string): ChatMiddlewareRegistration | undefined {
  return registry.get(fullId)
}

/**
 * Bump the failure counter for a middleware. Trips the breaker (set
 * `disabled=true`, emit `breaker-tripped`) once the threshold is reached.
 * Returns whether the middleware is now tripped.
 */
export function recordMiddlewareFailure(fullId: string, reason: string): boolean {
  const entry = registry.get(fullId)
  if (!entry) return false
  entry.consecutiveFailures += 1
  if (entry.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !entry.disabled) {
    entry.disabled = true
    entry.breakerTripped = true
    emit({ type: "breaker-tripped", fullId, pluginId: entry.pluginId, reason })
  }
  return entry.disabled
}

/** Reset the failure counter (called on each successful run). */
export function recordMiddlewareSuccess(fullId: string): void {
  const entry = registry.get(fullId)
  if (!entry) return
  if (entry.consecutiveFailures > 0) {
    entry.consecutiveFailures = 0
  }
}

/**
 * Manually re-enable a tripped middleware. Used by the settings UI's
 * "retry" button or by `clearChatMiddlewaresForPlugin` indirectly when a
 * plugin re-enables.
 */
export function resetChatMiddlewareBreaker(fullId: string): boolean {
  const entry = registry.get(fullId)
  if (!entry) return false
  entry.consecutiveFailures = 0
  entry.disabled = false
  entry.breakerTripped = false
  emit({ type: "breaker-reset", fullId, pluginId: entry.pluginId })
  return true
}

export function subscribeChatMiddlewareRegistry(
  listener: (event: ChatMiddlewareEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only — wipe registry + listeners. */
export function __resetChatMiddlewareRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
}
