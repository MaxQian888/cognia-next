/**
 * Plan-approval bus for the Agent Teams runtime.
 *
 * The runtime suspends a team's lifecycle while a human reviews the lead's
 * proposed plan. Rather than coupling the runtime to a specific store
 * action or React render path, the suspension awaits a single `Promise`
 * resolved by this small pub/sub.
 *
 * Producers: the plan-approval UI calls `approve(teamId, plan)` /
 * `reject(teamId, feedback)`.
 *
 * Consumers: the runtime calls `waitForDecision(teamId, signal)` and
 * `await`s the returned promise.
 */

export interface PlanApprovalDecision {
  /** "approve" — runtime proceeds with the plan as-is. */
  /** "reject" — runtime hands feedback back to the lead and aborts the run. */
  outcome: "approve" | "reject"
  /** Caller-supplied feedback string. Optional on approve. */
  feedback?: string
  /** The plan blob the producer wishes to commit. Forwarded verbatim. */
  plan?: unknown
}

type Resolver = (decision: PlanApprovalDecision) => void

const pending = new Map<string, Set<Resolver>>()

/**
 * Wait for an approve or reject signal for `teamId`. Resolves with the
 * caller-supplied decision once `approve()` or `reject()` is called for
 * the same `teamId`. If `signal` aborts before either fires, the
 * promise rejects with the abort reason and the resolver is removed.
 */
export function waitForDecision(
  teamId: string,
  signal?: AbortSignal
): Promise<PlanApprovalDecision> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const set = pending.get(teamId) ?? new Set<Resolver>()
    pending.set(teamId, set)

    const resolver: Resolver = (decision) => {
      set.delete(resolver)
      if (set.size === 0) pending.delete(teamId)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve(decision)
    }

    const onAbort = () => {
      set.delete(resolver)
      if (set.size === 0) pending.delete(teamId)
      reject(signal?.reason ?? new Error("Aborted"))
    }

    set.add(resolver)
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Notify every waiter for `teamId` that the plan was approved. */
export function approve(teamId: string, plan?: unknown): number {
  const set = pending.get(teamId)
  if (!set || set.size === 0) return 0
  // Snapshot — resolvers mutate the set as they fire.
  const fanout = [...set]
  for (const resolver of fanout) {
    resolver({ outcome: "approve", plan })
  }
  return fanout.length
}

/** Notify every waiter for `teamId` that the plan was rejected. */
export function reject(teamId: string, feedback?: string): number {
  const set = pending.get(teamId)
  if (!set || set.size === 0) return 0
  const fanout = [...set]
  for (const resolver of fanout) {
    resolver({ outcome: "reject", feedback })
  }
  return fanout.length
}

/** Test utility — drop every pending waiter without resolving. */
export function __resetForTesting(): void {
  pending.clear()
}

/** Test utility — count of currently-pending waiters for `teamId`. */
export function pendingCount(teamId: string): number {
  return pending.get(teamId)?.size ?? 0
}
