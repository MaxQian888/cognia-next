/**
 * Generic approval bus — scope+id-keyed pub/sub for "wait until human (or
 * another async actor) decides approve/reject" workflows.
 *
 * Extracted from `lib/ai/agent/plan-approval-bus.ts` so the same primitive
 * powers Agent-Team plan approvals AND GitHub Delivery's HITL guard. Pure
 * in-memory; the durable side of any approval (draft row, Dexie state)
 * lives in the caller's domain.
 */

export interface ApprovalKey {
  /** Logical bucket — e.g., "agent-team", "github". */
  scope: string
  /** Per-scope identifier — team id, draft id, work-order id, … */
  id: string
}

export interface ApprovalDecision {
  /** "approve" — caller proceeds with `plan` (if any). */
  /** "reject" — caller aborts; `feedback` carries the reason. */
  outcome: "approve" | "reject"
  /** Optional approver feedback (free text). */
  feedback?: string
  /** Optional payload the approver wishes to commit (edited content, etc.). */
  plan?: unknown
}

type Resolver = (decision: ApprovalDecision) => void

function keyStr(key: ApprovalKey): string {
  return `${key.scope}::${key.id}`
}

const pending = new Map<string, Set<Resolver>>()

/**
 * Wait until `approve(key)` or `reject(key)` fires. If `signal` aborts
 * first, the promise rejects with the abort reason and the waiter is
 * removed without resolving.
 */
export function waitForDecision(key: ApprovalKey, signal?: AbortSignal): Promise<ApprovalDecision> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const k = keyStr(key)
    const set = pending.get(k) ?? new Set<Resolver>()
    pending.set(k, set)

    const resolver: Resolver = (decision) => {
      set.delete(resolver)
      if (set.size === 0) pending.delete(k)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve(decision)
    }

    const onAbort = () => {
      set.delete(resolver)
      if (set.size === 0) pending.delete(k)
      reject(signal?.reason ?? new Error("Aborted"))
    }

    set.add(resolver)
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Resolve every waiter for `key` with outcome="approve". Returns fanout. */
export function approve(key: ApprovalKey, plan?: unknown): number {
  const set = pending.get(keyStr(key))
  if (!set || set.size === 0) return 0
  const fanout = [...set]
  for (const resolver of fanout) {
    resolver({ outcome: "approve", plan })
  }
  return fanout.length
}

/** Resolve every waiter for `key` with outcome="reject". Returns fanout. */
export function reject(key: ApprovalKey, feedback?: string): number {
  const set = pending.get(keyStr(key))
  if (!set || set.size === 0) return 0
  const fanout = [...set]
  for (const resolver of fanout) {
    resolver({ outcome: "reject", feedback })
  }
  return fanout.length
}

/** Count of currently-pending waiters for `key`. Test utility. */
export function pendingCount(key: ApprovalKey): number {
  return pending.get(keyStr(key))?.size ?? 0
}

/**
 * Drop every pending waiter (across all scopes) without resolving. Used by
 * tests between cases. Production callers should never need this.
 */
export function __resetForTesting(): void {
  pending.clear()
}
