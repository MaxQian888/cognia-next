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

import { getExecutionBroker } from "./broker"
import type { ExecutionBroker } from "./broker"
import type { ExecutionLease, ExecutionLegKind } from "./types"
import { useChatStore } from "@/stores/chat"
import { interruptSession } from "@/lib/claude/ipc"

interface HeldChatLease {
  lease: ExecutionLease
  /** Set once the session has been observed in an active state. We only release
   *  after that, so a still-`idle` status right after acquire (before `send`
   *  flips it to `streaming`) can't trigger a premature release. */
  sawActive: boolean
}

const held = new Map<string, HeldChatLease>()
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
  const lease = await broker.acquire({
    kind: params.kind ?? "chat",
    label: params.label,
    sessionId: params.sessionId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.slotKey ? { slotKey: params.slotKey } : {}),
  })
  // A broker-side cancel aborts the lease signal — bridge it to an interrupt so
  // the live turn actually stops. (A normal release never fires `abort`.)
  const onCancel =
    params.onCancel ?? (() => void interruptSession(params.sessionId).catch(() => undefined))
  lease.signal.addEventListener("abort", () => onCancel(), { once: true })
  held.set(params.sessionId, { lease, sawActive: false })
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
  unsubscribeWatcher?.()
  unsubscribeWatcher = null
  watcherInstalled = false
}
