/**
 * Plugin SDK helper for semantic interceptors (ADR-0189).
 *
 * Pure: it builds a contribution description and returns it. It does NOT
 * register anything. That is the whole point of the shape — registration
 * happens when the host reads `activate()`'s return value, so it is tied to the
 * activation lease (plugin id, generation, realm, trust tier) rather than to
 * whenever a module happened to be imported. A helper that registered as a side
 * effect would leave a plugin half-live after a hot reload, with the previous
 * generation's closures still on the chain.
 *
 * ```ts
 * export function activate(ctx: PluginContext) {
 *   return defineInterceptors([
 *     {
 *       point: "tool.result.project",
 *       after: ["@cognia/redact"],
 *       failurePolicy: "fail-closed",
 *       handler: (value) => ({ ...value, projection: redact(value.projection) }),
 *     },
 *   ])
 * }
 * ```
 */

import type {
  PluginInterceptorContribution,
  PluginInterceptorPoint,
} from "@/types/plugin/plugin-interceptors"

export interface PluginInterceptorContributions {
  interceptors: readonly PluginInterceptorContribution[]
}

/**
 * Describe the interceptors a plugin contributes.
 *
 * Duplicate ids are rejected here rather than at registration: two
 * contributions sharing an id would collapse into one record, and the author
 * would see a handler silently never run instead of an error naming the
 * collision.
 */
export function defineInterceptors(
  interceptors: readonly PluginInterceptorContribution[]
): PluginInterceptorContributions {
  const seen = new Set<string>()
  for (const entry of interceptors) {
    if (!entry.id) continue
    const key = `${entry.point}:${entry.id}`
    if (seen.has(key)) {
      throw new Error(
        `[defineInterceptors] duplicate interceptor id "${entry.id}" on point "${entry.point}"`
      )
    }
    seen.add(key)
  }
  return { interceptors }
}

/** Typed single-entry helper, for the common one-interceptor plugin. */
export function defineInterceptor<TPoint extends PluginInterceptorPoint>(
  contribution: PluginInterceptorContribution & { point: TPoint }
): PluginInterceptorContribution & { point: TPoint } {
  return contribution
}
