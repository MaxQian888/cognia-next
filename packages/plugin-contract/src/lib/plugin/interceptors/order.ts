/**
 * Deterministic interceptor ordering (ADR-0189 §6.1).
 *
 * Both registries this replaces sorted on one number — chat middleware on
 * `priority`, plugin hooks on `priority` — which cannot express the only
 * ordering constraint plugin authors actually have: "run me after the redactor"
 * is a statement about a NEIGHBOUR, not about a magnitude. Authors compensated
 * by bidding priority numbers up, which is a race nobody wins and which silently
 * reorders every time a new plugin is installed.
 *
 * So ordering is resolved in four stages, most-significant first:
 *
 *   1. trust tier      — builtin wraps verified wraps community. Not
 *                        negotiable, and not self-declared (see
 *                        `InterceptorTrustTier`).
 *   2. before/after DAG — an explicit partial order over neighbours.
 *   3. priority         — breaks ties the DAG leaves open.
 *   4. registrationId   — the final, stable tiebreak, so two installs of the
 *                        same set produce the same chain.
 *
 * The DAG is resolved with Kahn's algorithm over a queue kept in stage-1/3/4
 * order, so the tier and priority intent survives wherever the graph does not
 * contradict it.
 *
 * Failure handling is deliberately non-fatal. A dangling `after: ["nope"]` or a
 * cycle between two third-party plugins must not take the point offline for
 * everyone else — one author's typo becoming an outage for every other plugin
 * on the point is a worse failure than a slightly arbitrary order. Both cases
 * drop the offending EDGES, keep every registration, and report a diagnostic.
 */

import {
  INTERCEPTOR_TRUST_ORDER,
  type InterceptorOrderDiagnostic,
  type InterceptorRegistration,
} from "./types"

export interface InterceptorOrderResult {
  /** Registrations in dispatch order — index 0 runs first / outermost. */
  ordered: InterceptorRegistration[]
  diagnostics: InterceptorOrderDiagnostic[]
}

/** Stage 1 + 3 + 4: the order used wherever the DAG imposes nothing. */
function baselineCompare(a: InterceptorRegistration, b: InterceptorRegistration): number {
  const byTier = INTERCEPTOR_TRUST_ORDER[a.trustTier] - INTERCEPTOR_TRUST_ORDER[b.trustTier]
  if (byTier !== 0) return byTier
  const byPriority = (b.order.priority ?? 0) - (a.order.priority ?? 0)
  if (byPriority !== 0) return byPriority
  return a.registrationId.localeCompare(b.registrationId)
}

/**
 * Resolve one ordering reference to the registration ids it names.
 *
 * A reference is either a registration id (exact) or a plugin id (every
 * registration that plugin holds on this point). Naming a plugin is the form
 * authors reach for first — "after `@cognia/redact`" — and it keeps working
 * when that plugin adds a second interceptor, which an exact id does not.
 */
function resolveReference(
  reference: string,
  byRegistrationId: ReadonlyMap<string, InterceptorRegistration>,
  byPluginId: ReadonlyMap<string, InterceptorRegistration[]>
): string[] {
  if (byRegistrationId.has(reference)) return [reference]
  const owned = byPluginId.get(reference)
  if (owned) return owned.map((entry) => entry.registrationId)
  return []
}

export function resolveInterceptorOrder(
  pointId: string,
  registrations: readonly InterceptorRegistration[]
): InterceptorOrderResult {
  const diagnostics: InterceptorOrderDiagnostic[] = []
  if (registrations.length <= 1) {
    return { ordered: [...registrations], diagnostics }
  }

  const byRegistrationId = new Map(registrations.map((entry) => [entry.registrationId, entry]))
  const byPluginId = new Map<string, InterceptorRegistration[]>()
  for (const entry of registrations) {
    const bucket = byPluginId.get(entry.pluginId)
    if (bucket) bucket.push(entry)
    else byPluginId.set(entry.pluginId, [entry])
  }

  // edges: from → set(to), meaning `from` dispatches before `to`.
  const edges = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()
  for (const entry of registrations) {
    edges.set(entry.registrationId, new Set())
    indegree.set(entry.registrationId, 0)
  }

  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    const bucket = edges.get(from)
    if (!bucket || bucket.has(to)) return
    bucket.add(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }

  const missing: Array<{ registrationId: string; reference: string }> = []
  for (const entry of registrations) {
    for (const reference of entry.order.before ?? []) {
      const targets = resolveReference(reference, byRegistrationId, byPluginId)
      if (targets.length === 0) {
        missing.push({ registrationId: entry.registrationId, reference })
        continue
      }
      for (const target of targets) addEdge(entry.registrationId, target)
    }
    for (const reference of entry.order.after ?? []) {
      const targets = resolveReference(reference, byRegistrationId, byPluginId)
      if (targets.length === 0) {
        missing.push({ registrationId: entry.registrationId, reference })
        continue
      }
      for (const target of targets) addEdge(target, entry.registrationId)
    }
  }

  for (const entry of missing) {
    diagnostics.push({
      code: "interceptor.order.missing-dependency",
      pointId,
      registrationIds: [entry.registrationId],
      message:
        `Interceptor "${entry.registrationId}" orders itself against "${entry.reference}", ` +
        `which is not registered on "${pointId}". The constraint is ignored.`,
    })
  }

  // Kahn, with the ready set kept in baseline order so tier/priority decides
  // whenever the graph is indifferent.
  const ready = registrations
    .filter((entry) => (indegree.get(entry.registrationId) ?? 0) === 0)
    .sort(baselineCompare)
  const ordered: InterceptorRegistration[] = []
  const emitted = new Set<string>()

  while (ready.length > 0) {
    const next = ready.shift()!
    ordered.push(next)
    emitted.add(next.registrationId)
    let unlockedAny = false
    for (const target of edges.get(next.registrationId) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1
      indegree.set(target, remaining)
      if (remaining === 0) {
        const entry = byRegistrationId.get(target)
        if (entry) {
          ready.push(entry)
          unlockedAny = true
        }
      }
    }
    if (unlockedAny) ready.sort(baselineCompare)
  }

  if (ordered.length !== registrations.length) {
    // Whatever Kahn could not drain sits on at least one cycle. Keep every
    // registration; append the remainder in baseline order and say so.
    const stuck = registrations
      .filter((entry) => !emitted.has(entry.registrationId))
      .sort(baselineCompare)
    diagnostics.push({
      code: "interceptor.order.cycle",
      pointId,
      registrationIds: stuck.map((entry) => entry.registrationId),
      message:
        `before/after constraints on "${pointId}" form a cycle across ` +
        `${stuck.map((entry) => `"${entry.registrationId}"`).join(", ")}. ` +
        `The constraints that close it are ignored and trust tier / priority decides.`,
    })
    ordered.push(...stuck)
  }

  // Stage 1 is absolute: a community interceptor may not order itself outside a
  // builtin one. The DAG can only arrange registrations WITHIN a tier, so a
  // cross-tier edge that survived the graph is reported and the tier wins.
  const tierViolations: string[] = []
  for (let index = 1; index < ordered.length; index++) {
    const previous = INTERCEPTOR_TRUST_ORDER[ordered[index - 1]!.trustTier]
    const current = INTERCEPTOR_TRUST_ORDER[ordered[index]!.trustTier]
    if (current < previous) tierViolations.push(ordered[index]!.registrationId)
  }
  if (tierViolations.length > 0) {
    diagnostics.push({
      code: "interceptor.order.tier-conflict",
      pointId,
      registrationIds: tierViolations,
      message:
        `before/after constraints on "${pointId}" would place ` +
        `${tierViolations.map((id) => `"${id}"`).join(", ")} outside a more trusted ` +
        `interceptor. Trust tier wins; the constraint is ignored.`,
    })
    // Stable re-sort against a snapshot of the current positions: reading
    // `indexOf` on the array being sorted would consult a half-permuted array.
    const positions = new Map(ordered.map((entry, index) => [entry.registrationId, index]))
    ordered.sort((a, b) => {
      const byTier = INTERCEPTOR_TRUST_ORDER[a.trustTier] - INTERCEPTOR_TRUST_ORDER[b.trustTier]
      if (byTier !== 0) return byTier
      return (positions.get(a.registrationId) ?? 0) - (positions.get(b.registrationId) ?? 0)
    })
  }

  return { ordered, diagnostics }
}
