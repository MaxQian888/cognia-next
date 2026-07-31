/**
 * Runtime plugin load-order resolver.
 *
 * `manifest.dependencies` (required) and `manifest.optionalDependencies` exist
 * on the manifest but nothing consumed them: plugins enabled in arbitrary
 * discovery order, so a plugin whose required dependency hadn't loaded yet
 * failed inside `activate()`. This module computes a dependency-respecting
 * enable order over the *runtime* plugin set (ids + versions + statuses),
 * decides which plugins must be BLOCKED (a required dependency is missing,
 * disabled, version-mismatched, or itself blocked/cyclic) versus DEGRADED (an
 * optional dependency is unmet), and reports dependency cycles.
 *
 * Distinct from `lib/plugin/package/dependency-resolver.ts`, which answers an
 * install-time question (which versions to fetch from the marketplace) and has
 * no notion of runtime `enabled/disabled` status. We reuse its pure
 * `satisfiesConstraint` version-math helper rather than reimplement semver.
 */

import type { PluginStatus } from "@/types/plugin"
import { satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"

/** Why a plugin can't have one of its required dependencies satisfied. */
export type LoadOrderBlockReason =
  | { kind: "missing"; dependencyId: string; constraint: string }
  | { kind: "disabled"; dependencyId: string; constraint: string }
  | { kind: "version-mismatch"; dependencyId: string; constraint: string; found: string }
  | { kind: "cycle"; dependencyId: string; constraint: string }

export interface LoadOrderPluginInput {
  id: string
  version: string
  /** Required deps: pluginId → version constraint. */
  dependencies?: Record<string, string>
  /** Optional deps: pluginId → version constraint. Unmet → degraded, not blocked. */
  optionalDependencies?: Record<string, string>
  status: PluginStatus
}

export interface LoadOrderResult {
  /** Plugin ids in dependency-respecting enable order (deps before dependents). */
  order: string[]
  /**
   * The same survivors grouped into dependency layers: every plugin in
   * `layers[n]` has all its required deps in `layers[0..n-1]`, so a layer's
   * members can be enabled CONCURRENTLY. `layers.flat()` equals `order`.
   */
  layers: string[][]
  /** Each dependency cycle as the list of ids forming it (reported once). */
  cycles: string[][]
  /** pluginId → reasons its required deps can't be satisfied (excluded from `order`). */
  blocked: Map<string, LoadOrderBlockReason[]>
  /** pluginId → optional dep ids that are unmet (still enabled, in degraded mode). */
  degraded: Map<string, string[]>
}

/** Statuses where a plugin will NOT end up running, so it can't satisfy a dep. */
function isUnavailableStatus(status: PluginStatus): boolean {
  return status === "disabled" || status === "error"
}

/**
 * Tarjan's strongly-connected-components, returning only the components that
 * are genuine cycles (size > 1, or a single node with a self-edge). Operates
 * over the required-dependency graph (edge: plugin → each required dep that
 * exists in the set).
 */
function findCycles(ids: readonly string[], requiredEdges: Map<string, string[]>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const strongConnect = (v: string): void => {
    indices.set(v, index)
    lowlink.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)

    for (const w of requiredEdges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)

      const hasSelfEdge = (requiredEdges.get(v) ?? []).includes(v)
      if (component.length > 1 || hasSelfEdge) {
        cycles.push(component.reverse())
      }
    }
  }

  for (const id of ids) {
    if (!indices.has(id)) strongConnect(id)
  }
  return cycles
}

/**
 * Resolve the enable order for a runtime plugin set.
 *
 * The returned `order` contains exactly the plugins that are neither blocked
 * nor part of a cycle, sorted so every required dependency precedes its
 * dependents. Independent plugins keep their input order (stable).
 */
export function resolveLoadOrder(plugins: readonly LoadOrderPluginInput[]): LoadOrderResult {
  const byId = new Map<string, LoadOrderPluginInput>()
  for (const p of plugins) byId.set(p.id, p)

  // Required-edge graph (plugin → required deps that exist in the set) for cycle
  // detection. Deps outside the set don't form edges (they surface as "missing").
  const requiredEdges = new Map<string, string[]>()
  for (const p of plugins) {
    const deps = Object.keys(p.dependencies ?? {}).filter((d) => byId.has(d))
    requiredEdges.set(p.id, deps)
  }

  const cycles = findCycles(
    plugins.map((p) => p.id),
    requiredEdges
  )
  const cycleMembers = new Set<string>(cycles.flat())

  const blocked = new Map<string, LoadOrderBlockReason[]>()

  // `enableable` shrinks as we discover blockers. A plugin leaves the set when a
  // required dep is missing / version-mismatched / itself unavailable. Removal
  // cascades (a dependent of a blocked plugin becomes blocked too), so we run to
  // a fixpoint.
  const enableable = new Set<string>(
    plugins
      .filter((p) => !isUnavailableStatus(p.status) && !cycleMembers.has(p.id))
      .map((p) => p.id)
  )

  let changed = true
  while (changed) {
    changed = false
    for (const id of [...enableable]) {
      const plugin = byId.get(id)!
      const reasons: LoadOrderBlockReason[] = []
      for (const [depId, constraint] of Object.entries(plugin.dependencies ?? {})) {
        const dep = byId.get(depId)
        if (!dep) {
          reasons.push({ kind: "missing", dependencyId: depId, constraint })
        } else if (cycleMembers.has(depId)) {
          reasons.push({ kind: "cycle", dependencyId: depId, constraint })
        } else if (!enableable.has(depId)) {
          // Dep present but won't be enabled (user-disabled, errored, or itself
          // blocked in a previous fixpoint pass).
          reasons.push({ kind: "disabled", dependencyId: depId, constraint })
        } else if (!satisfiesConstraint(dep.version, constraint)) {
          reasons.push({
            kind: "version-mismatch",
            dependencyId: depId,
            constraint,
            found: dep.version,
          })
        }
      }
      if (reasons.length > 0) {
        blocked.set(id, reasons)
        enableable.delete(id)
        changed = true
      }
    }
  }

  // Kahn topological sort over the survivors (guaranteed acyclic: cycle members
  // were excluded up front). Edge dep → dependent, so deps emit first.
  const survivors = plugins.filter((p) => enableable.has(p.id)).map((p) => p.id)
  const survivorSet = new Set(survivors)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const id of survivors) indegree.set(id, 0)
  for (const id of survivors) {
    for (const depId of requiredEdges.get(id) ?? []) {
      if (!survivorSet.has(depId)) continue
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
      dependents.set(depId, [...(dependents.get(depId) ?? []), id])
    }
  }

  // Seed the first frontier in input order so independent plugins stay stable,
  // then drain frontier-by-frontier. Processing a whole frontier before its
  // dependents yields the same flattened sequence as a FIFO Kahn drain while
  // also exposing the dependency layers for concurrent enable.
  const order: string[] = []
  const layers: string[][] = []
  let frontier = survivors.filter((id) => (indegree.get(id) ?? 0) === 0)
  while (frontier.length > 0) {
    layers.push([...frontier])
    const nextFrontier: string[] = []
    for (const id of frontier) {
      order.push(id)
      for (const dependent of dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1
        indegree.set(dependent, next)
        if (next === 0) nextFrontier.push(dependent)
      }
    }
    frontier = nextFrontier
  }

  // Degraded: unmet optional deps for plugins that DID make it into the order.
  const degraded = new Map<string, string[]>()
  for (const id of order) {
    const plugin = byId.get(id)!
    const unmet: string[] = []
    for (const [depId, constraint] of Object.entries(plugin.optionalDependencies ?? {})) {
      const dep = byId.get(depId)
      if (!dep || !enableable.has(depId) || !satisfiesConstraint(dep.version, constraint)) {
        unmet.push(depId)
      }
    }
    if (unmet.length > 0) degraded.set(id, unmet)
  }

  return { order, layers, cycles, blocked, degraded }
}
