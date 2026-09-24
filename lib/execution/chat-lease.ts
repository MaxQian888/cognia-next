/**
 * Foreground-chat admission glue.
 *
 * Foreground chat turns go through the `sendPrompt` IPC (fire-and-forget),
 * NOT `runAndCaptureAssistantReply`, so the run-and-capture chokepoint never
 * sees them. This module gives a chat turn a broker lease for its lifetime so
 * the global ExecutionBroker counts chat occupancy alongside the headless legs
 * (and the execution panel can observe / cancel a chat turn).
 *
 * Lifecycle: `acquireChatLease` is called by `use-claude-chat`'s `send()` right
 * before the turn flips to `streaming`. The lease is released by a single
 * store-subscription watcher when the session leaves an active state
 * (`streaming` / `awaiting_approval`) — which covers every settle path
 * (session_ended, error, interrupt, external-agent completion) without having
 * to hook each one. A broker-side cancel aborts `lease.signal`, which we bridge
 * to `interruptSession` so the turn actually stops.
 */

import { ExecutionAbortError, getExecutionBroker } from "./broker"
import type { ExecutionBroker } from "./broker"
import type {
  ExecutionAdmissionBlocker,
  ExecutionLease,
  ExecutionLeaseRequest,
  ExecutionLegKind,
} from "./types"
import { useChatStore } from "@/stores/chat"
import { interruptSession } from "@/lib/claude/ipc"

interface HeldChatLease {
  lease: ExecutionLease
  params: AcquireChatLeaseParams
  /** Set once the session has been observed in an active state. We only release
   *  after that, so a still-`idle` status right after acquire (before `send`
   *  flips it to `streaming`) can't trigger a premature release. */
  sawActive: boolean
}

const held = new Map<string, HeldChatLease>()
/**
 * Turns the broker parked instead of admitting, keyed by session, with the
 * controller that withdraws the wait. Present only between the refusal to admit
 * and the admission (or cancellation) that ends it.
 */
const queued = new Map<string, AbortController>()
let watcherInstalled = false
let unsubscribeWatcher: (() => void) | null = null

const ACTIVE_STATUSES = new Set(["streaming", "awaiting_approval"])

function ensureWatcher(): void {
  if (watcherInstalled) return
  watcherInstalled = true
  unsubscribeWatcher = useChatStore.subscribe((state) => {
    if (held.size === 0) return
    for (const [sessionId, entry] of [...held.entries()]) {
      const status = state.sessions[sessionId]?.status ?? "idle"
      if (ACTIVE_STATUSES.has(status)) {
        entry.sawActive = true
        continue
      }
      // Settled (idle / error). Only release once we've seen the turn run, so
      // the gap between acquire and the `streaming` flip never releases early.
      if (entry.sawActive) {
        entry.lease.release(status === "error" ? "error" : "ok")
        held.delete(sessionId)
      }
    }
  })
}

export interface AcquireChatLeaseParams {
  sessionId: string
  projectId?: string
  /** Display label for the execution panel — pass the session title. */
  label: string
  /**
   * The working tree this turn will mutate. Two turns naming the same slot are
   * serialized by the broker; turns in different trees run in parallel.
   *
   * Omitted for a turn that touches nothing shared. Callers get it from
   * `slotKeyForTurn`, fed by the same `resolveEffectiveCwd` chain the send
   * path uses — so a conversation in a managed worktree serializes against
   * that worktree and not against its source repository, and two plain
   * conversations sharing a workspace root serialize against each other.
   */
  slotKey?: string
  /** Leg kind for the execution panel; foreground chat turns default to
   *  "chat", team turns pass "team". */
  kind?: Extract<ExecutionLegKind, "chat" | "team">
  /**
   * Broker-side cancel bridge. Defaults to `interruptSession(sessionId)`,
   * which is right for direct chat; team turns pass their own — the live
   *  work runs under per-member sub-session ids, not `sessionId` itself.
   */
  onCancel?: () => void
  providerId?: string
  providerLimit?: number
  /**
   * Called synchronously — before the wait starts — when the broker is about
   * to QUEUE this turn rather than admit it, with what it is waiting for.
   *
   * The send path uses it to put the user's message on screen as queued. Without
   * it the turn sat inside `acquire` with nothing to show for it: no message, no
   * error, until whatever held the working tree let go minutes later. A turn
   * that queues this way can be withdrawn with {@link cancelQueuedChatTurn}.
   */
  onQueued?: (blocker: ExecutionAdmissionBlocker) => void
}

/**
 * Acquire (or reuse) a broker lease for a chat turn on `sessionId`. A no-op
 * when a lease for the session is already held (a continuation — the broker
 * exemption already covers the streaming session). Resolves once admitted;
 * because `send()` gates on {@link ExecutionBroker.isAtCapacity} first, this
 * normally resolves immediately.
 */
export async function acquireChatLease(
  params: AcquireChatLeaseParams,
  broker: ExecutionBroker = getExecutionBroker()
): Promise<void> {
  ensureWatcher()
  if (held.has(params.sessionId)) return
  const request: ExecutionLeaseRequest = {
    kind: params.kind ?? "chat",
    label: params.label,
    sessionId: params.sessionId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.slotKey ? { slotKey: params.slotKey } : {}),
    ...(params.providerId ? { providerId: params.providerId } : {}),
    ...(params.providerLimit ? { providerLimit: params.providerLimit } : {}),
  }
  // Asked and acted on in the same tick as the acquire below, so the answer
  // cannot go stale between the question and the queueing it predicts.
  const blocker = broker.admissionBlocker(request)
  let waiting: AbortController | null = null
  if (blocker) {
    waiting = new AbortController()
    request.signal = waiting.signal
    queued.set(params.sessionId, waiting)
    params.onQueued?.(blocker)
  }
  let lease: ExecutionLease
  try {
    lease = await broker.acquire(request)
  } finally {
    if (waiting && queued.get(params.sessionId) === waiting) queued.delete(params.sessionId)
  }
  // A broker-side cancel aborts the lease signal — bridge it to an interrupt so
  // the live turn actually stops. (A normal release never fires `abort`.)
  const onCancel =
    params.onCancel ?? (() => void interruptSession(params.sessionId).catch(() => undefined))
  lease.signal.addEventListener("abort", () => onCancel(), { once: true })
  held.set(params.sessionId, { lease, params, sawActive: false })
}

/**
 * Hand a foreground turn from a failed provider lane to its fallback lane.
 *
 * The replacement is acquired BEFORE the old lease is released. Releasing first
 * looks safer, but `ExecutionBroker.release` calls `drain` synchronously, so the
 * freed permit is handed to whatever was already queued and the re-acquire for a
 * turn that is mid-flight lands at the back of that queue. The routing fallback
 * then never reaches `sendPrompt` and the user's turn stalls instead of failing
 * over.
 *
 * Acquiring first cannot deadlock: the old lease is still running for this
 * session, so the broker's continuation exemption (a RUNNING leg) admits
 * the replacement immediately without waiting on the shared pool, the slot, or
 * the fallback provider's lane. The old lease is released straight afterwards,
 * which returns its permits and drains whoever was waiting on them.
 */
export async function switchChatLeaseProvider(
  sessionId: string,
  providerId: string | undefined,
  providerLimit: number | undefined,
  broker: ExecutionBroker = getExecutionBroker()
): Promise<void> {
  const current = held.get(sessionId)
  if (!current) return
  if (current.params.providerId === providerId && current.params.providerLimit === providerLimit) {
    return
  }
  const {
    providerId: _previousProviderId,
    providerLimit: _previousProviderLimit,
    ...sharedParams
  } = current.params
  const nextParams: AcquireChatLeaseParams = {
    ...sharedParams,
    ...(providerId ? { providerId } : {}),
    ...(providerLimit ? { providerLimit } : {}),
  }
  // `acquireChatLease` is a no-op while an entry is held for the session, so the
  // slot has to be free before it runs. The lease object stays in hand, which is
  // what keeps the exemption alive and lets the old lane be released on failure.
  held.delete(sessionId)
  try {
    await acquireChatLease(nextParams, broker)
  } catch (error) {
    // Keep the turn on the lane it already has rather than leaving it holding
    // nothing at all.
    held.set(sessionId, current)
    throw error
  }
  current.lease.release("error")
}

/** Whether a turn for `sessionId` is waiting for admission right now. */
export function isChatTurnQueued(sessionId: string): boolean {
  return queued.has(sessionId)
}

/**
 * Withdraw a turn that is still waiting for admission. Its pending
 * {@link acquireChatLease} rejects with an {@link ExecutionAbortError}, which the
 * send path reads as "the user took this message back" — never as a failure.
 * Returns false when nothing is waiting (it was admitted, or already gone).
 */
export function cancelQueuedChatTurn(sessionId: string): boolean {
  const waiting = queued.get(sessionId)
  if (!waiting) return false
  queued.delete(sessionId)
  waiting.abort()
  return true
}

/** True for the rejection {@link cancelQueuedChatTurn} produces. */
export function isQueuedChatTurnCancellation(error: unknown): boolean {
  return error instanceof ExecutionAbortError
}

/**
 * Release a held chat lease immediately (e.g. a pre-stream failure path).
 * Idempotent / no-op when nothing is held for the session.
 */
export function releaseChatLease(
  sessionId: string,
  outcome: "ok" | "error" | "cancelled" = "ok"
): void {
  const entry = held.get(sessionId)
  if (!entry) return
  entry.lease.release(outcome)
  held.delete(sessionId)
}

/** Tear down all held leases + the watcher (tests only). */
export function __resetChatLeasesForTesting(): void {
  for (const entry of held.values()) entry.lease.release("ok")
  held.clear()
  for (const waiting of queued.values()) waiting.abort()
  queued.clear()
  unsubscribeWatcher?.()
  unsubscribeWatcher = null
  watcherInstalled = false
}
