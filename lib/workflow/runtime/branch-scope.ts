/**
 * Branch-scope computation for `flow.join` race cancellation (P3).
 *
 * When a race join proceeds on its first completed input, the still-running
 * sibling branches must be cancelled — but ONLY the losing branches: shared
 * ancestors (e.g. the trigger or a common fan-out node) feed the winner too
 * and must never be touched.
 *
 *   scope(loser) = reverseReachable(loser) − reverseReachable(winner) − {join}
 *
 * Pure functions over the top-level edge list (callers pre-filter loop-body
 * and back edges). Known limitation: a node inside a losing scope that ALSO
 * feeds a consumer outside the join cone gets cancelled with its branch —
 * authors should fan such nodes out before the racing section.
 */

export interface ScopeEdge {
  source: string
  target: string
}

/**
 * Abort reason used when a race join cancels a losing branch. The
 * orchestrator's catch maps steps aborted with this reason to
 * `step_skipped` (never `step_failed`, never the run's firstFailure, and
 * never an idempotency-cache entry).
 */
export class JoinCancelError extends Error {
  readonly isJoinCancel = true

  constructor(joinId: string) {
    super(`Cancelled — race join "${joinId}" already proceeded with another branch`)
    this.name = "JoinCancelError"
  }
}

export function isJoinCancel(reason: unknown): boolean {
  return (
    reason instanceof JoinCancelError ||
    (typeof reason === "object" &&
      reason !== null &&
      (reason as { isJoinCancel?: boolean }).isJoinCancel === true)
  )
}

/** Every node that can reach `from` over forward edges, INCLUDING `from`. */
export function reverseReachable(edges: ScopeEdge[], from: string): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const list = incoming.get(e.target)
    if (list) list.push(e.source)
    else incoming.set(e.target, [e.source])
  }
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const src of incoming.get(id) ?? []) {
      if (!seen.has(src)) {
        seen.add(src)
        stack.push(src)
      }
    }
  }
  return seen
}

/**
 * Nodes belonging exclusively to the losing branch feeding `loserDep`:
 * ancestors of the loser (and the loser itself) that are NOT ancestors of
 * the winner (shared fan-out / trigger nodes) and not the join itself.
 */
export function losingBranchScope(
  edges: ScopeEdge[],
  joinId: string,
  winnerDep: string,
  loserDep: string
): Set<string> {
  const loserScope = reverseReachable(edges, loserDep)
  const winnerScope = reverseReachable(edges, winnerDep)
  const scope = new Set<string>()
  for (const id of loserScope) {
    if (!winnerScope.has(id) && id !== joinId) scope.add(id)
  }
  return scope
}
