/**
 * The interceptor registry — one normalized store for every participation
 * record, whatever surface authored it (ADR-0189 §6.1).
 *
 * Before this module a plugin could join the pipeline through three unrelated
 * doors: the `PluginHooks` bag returned from `activate()`, `ctx.chat.use(...)`,
 * and (for out-of-process runtimes) a bridged before/after pair. Each door had
 * its own store, its own ordering rule and its own idea of what "this plugin is
 * disabled" means, so the same plugin could be live on one and dead on another.
 *
 * Every door now normalizes into `InterceptorRegistration` and lands here. The
 * legacy doors stay open — they are the authoring ergonomics, not a second
 * runtime — and `normalize.ts` is what turns them into records.
 *
 * Reuse, not reinvention:
 *   - storage is `createOverlayRegistry`, the same factory the other plugin
 *     registries ride, so `unregisterByPlugin` / `subscribe` / `getRevision`
 *     behave identically here;
 *   - liveness is `isPluginHooksEnabled`, the single rule every legacy
 *     dispatcher already consults. Duplicating it is precisely how they drifted
 *     apart the first time, so it sits in a leaf module both sides import.
 */

import { loggers } from "@/lib/plugin/core/logger"
import { createOverlayRegistry } from "@/lib/plugin/registries/createOverlayRegistry"
import { isPluginHooksEnabled } from "@/lib/plugin/registries/plugin-liveness"
import { getInterceptorPoint } from "./points"
import { resolveInterceptorOrder, type InterceptorOrderResult } from "./order"
import type { InterceptorOrderDiagnostic, InterceptorRegistration } from "./types"

const registry = createOverlayRegistry<InterceptorRegistration>({
  name: "plugin-interceptors",
  // Keyed by registrationId, which the host mints — so "last wins" only ever
  // means the same registration being refreshed (hot reload, snapshot restore).
  conflictPolicy: "last-wins",
})

/** Ordering is pure over (registrations on a point), so it caches by revision. */
interface OrderCacheEntry extends InterceptorOrderResult {
  revision: number
}
const orderCache = new Map<string, OrderCacheEntry>()

/**
 * Ordering diagnostics go somewhere by default.
 *
 * A cycle or a dangling `after:` is a plugin-author bug that the host resolves
 * silently — it drops the offending edges and carries on — so without a
 * subscriber the only signal the author gets is a chain that runs in an order
 * they did not ask for. The default listener puts it in the plugin log; a
 * devtools panel can subscribe alongside it.
 */
const defaultDiagnosticListener = (diagnostics: readonly InterceptorOrderDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    loggers.hooks.warn(`[interceptors] ${diagnostic.code}: ${diagnostic.message}`)
  }
}

const diagnosticListeners = new Set<(diagnostics: readonly InterceptorOrderDiagnostic[]) => void>([
  defaultDiagnosticListener,
])

function publishDiagnostics(diagnostics: readonly InterceptorOrderDiagnostic[]): void {
  if (diagnostics.length === 0) return
  for (const listener of diagnosticListeners) {
    try {
      listener(diagnostics)
    } catch {
      // A diagnostics consumer must never be able to break dispatch.
    }
  }
}

/**
 * Register one interceptor. Returns a disposer.
 *
 * The caller is the host — `normalize.ts` or the contribution loader — never a
 * plugin directly, because every identity field on the record (`pluginId`,
 * `generation`, `realmId`, `trustTier`) has to come from the activation lease
 * rather than from anything the plugin can state about itself.
 */
export function registerInterceptor(registration: InterceptorRegistration): () => void {
  registry.register(registration.registrationId, registration, {
    pluginId: registration.pluginId,
  })
  orderCache.delete(registration.pointId)
  return () => {
    unregisterInterceptor(registration.registrationId)
  }
}

export function unregisterInterceptor(registrationId: string): boolean {
  const existing = registry.get(registrationId)
  if (!existing) return false
  const removed = registry.unregisterById(registrationId)
  if (removed) orderCache.delete(existing.pointId)
  return removed
}

/**
 * Drop the interceptors a plugin registered through ONE authoring surface.
 *
 * Scoped because the surfaces clean up at different times: re-registering a
 * plugin's hook bag must not sweep away the middleware it registered through
 * `ctx.chat.use` on the same activation, which a plugin-wide drop would do.
 */
export function unregisterInterceptorsForPluginSource(
  pluginId: string,
  source: InterceptorRegistration["source"]
): number {
  const stale = registry
    .entries()
    .filter(({ entry }) => entry.pluginId === pluginId && entry.source === source)
    .map(({ entry }) => entry)
  for (const entry of stale) {
    registry.unregisterById(entry.registrationId)
    orderCache.delete(entry.pointId)
  }
  return stale.length
}

/** Drop every interceptor a plugin owns. Called on disable / unload. */
export function unregisterInterceptorsForPlugin(pluginId: string): number {
  const affected = new Set(
    registry
      .entries()
      .filter(({ entry }) => entry.pluginId === pluginId)
      .map(({ entry }) => entry.pointId)
  )
  const removed = registry.unregisterByPlugin(pluginId)
  for (const pointId of affected) orderCache.delete(pointId)
  return removed
}

/**
 * Drop every interceptor belonging to a superseded activation.
 *
 * A reload mints a new generation; the old one's handlers must stop running
 * even if their disposer never fired, because they close over a context whose
 * scope is already torn down. Keeping them would let a dead generation rewrite
 * a live request.
 */
export function unregisterInterceptorGeneration(pluginId: string, generation: number): number {
  const stale = registry
    .entries()
    .filter(({ entry }) => entry.pluginId === pluginId && entry.generation < generation)
    .map(({ entry }) => entry)
  for (const entry of stale) {
    registry.unregisterById(entry.registrationId)
    orderCache.delete(entry.pointId)
  }
  return stale.length
}

export function getInterceptor(registrationId: string): InterceptorRegistration | undefined {
  return registry.get(registrationId)
}

/** Every registration on a point, enabled or not, unordered. */
export function listInterceptorsForPoint(pointId: string): InterceptorRegistration[] {
  return registry
    .entries()
    .filter(({ entry }) => entry.pointId === pointId)
    .map(({ entry }) => entry)
}

/**
 * The dispatch chain for a point: live registrations in resolved order.
 *
 * "Live" is three conditions, all of which have bitten this codebase before:
 * the plugin is enabled, a handler is actually reachable (an out-of-process
 * record carries a `handlerRef` instead), and the registration's semantic
 * matches the point's.
 *
 * Only the ORDER is cached, and only against the registry's own revision.
 * Enablement deliberately is not: it lives in the plugin store and flips
 * without touching this registry, so a cache that covered it would keep
 * dispatching a plugin the user just disabled until some unrelated plugin
 * happened to register something. The same mistake the hook registry was
 * created to undo. Filtering an already-ordered list preserves relative order,
 * so toggling one plugin does not reshuffle the rest.
 *
 * Ordering diagnostics are published on the first resolve after a mutation
 * rather than on every dispatch, so a cycle is reported once instead of once
 * per chat turn.
 */
export function resolveInterceptorChain(pointId: string): InterceptorOrderResult {
  const revision = registry.getRevision()
  let cached = orderCache.get(pointId)
  if (!cached || cached.revision !== revision) {
    const point = getInterceptorPoint(pointId)
    const result = resolveInterceptorOrder(pointId, listInterceptorsForPoint(pointId))

    // A point declared as `around` cannot host a chain of anything else: the
    // semantics decide whether a return value replaces the result, and mixing
    // them on one point is how "my observer accidentally swallowed the
    // response" happens. Mismatches are dropped rather than coerced.
    const diagnostics = [...result.diagnostics]
    const ordered = result.ordered.filter((entry) => {
      if (!point || entry.semantic === point.semantic) return true
      diagnostics.push({
        code: "interceptor.order.tier-conflict",
        pointId,
        registrationIds: [entry.registrationId],
        message:
          `Interceptor "${entry.registrationId}" registered as "${entry.semantic}" on ` +
          `"${pointId}", which is a "${point.semantic}" point. It is not dispatched.`,
      })
      return false
    })

    cached = { ordered, diagnostics, revision }
    orderCache.set(pointId, cached)
    publishDiagnostics(diagnostics)
  }

  const live = cached.ordered.filter((entry) => {
    if (!isPluginHooksEnabled(entry.pluginId)) return false
    return typeof entry.handler === "function" || typeof entry.handlerRef === "string"
  })
  return { ordered: live, diagnostics: cached.diagnostics }
}

/** True when a point has at least one live interceptor — a cheap pre-check. */
export function hasInterceptors(pointId: string): boolean {
  return resolveInterceptorChain(pointId).ordered.length > 0
}

/** Every point id with at least one registration. Devtools + audits. */
export function listInterceptorPointsInUse(): string[] {
  return [...new Set(registry.entries().map(({ entry }) => entry.pointId))].sort()
}

export function subscribeInterceptorDiagnostics(
  listener: (diagnostics: readonly InterceptorOrderDiagnostic[]) => void
): () => void {
  diagnosticListeners.add(listener)
  return () => {
    diagnosticListeners.delete(listener)
  }
}

/** Test-only: drop every registration and cached ordering. */
export function __resetInterceptorRegistryForTesting(): void {
  registry.__resetForTesting()
  orderCache.clear()
  // Drop only what a test added; the default log sink is production behaviour
  // and clearing it would make the next test assert against a quieter host
  // than the real one.
  for (const listener of diagnosticListeners) {
    if (listener !== defaultDiagnosticListener) diagnosticListeners.delete(listener)
  }
}
