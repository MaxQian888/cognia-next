/**
 * Production wiring for the phantom-run guard (`phantom-run-reconciler.ts`).
 *
 * Kept apart from the reconciler so the decision logic stays testable against
 * plain fakes, while this file binds it to the real evidence: execution-broker
 * leases, open direct-chat runs, the companion room projector, the HostState
 * replica in Dexie and the partial transcript writer.
 */

import type { UIMessage } from "ai"

import type { HostStateTurnStatus } from "@cognia/agent-config-types/host-state"
import {
  installPhantomRunGuard,
  type PhantomRunDeps,
  type PhantomRunStore,
  type RunLiveness,
} from "@/lib/chat/phantom-run-reconciler"
import { getDb } from "@/lib/db/schema"

/** Host turn states in which the Host is still working the turn. */
const LIVE_HOST_TURNS: ReadonlySet<HostStateTurnStatus> = new Set<HostStateTurnStatus>([
  "queued",
  "running",
  "awaiting-decision",
  "stopping",
])

/**
 * Pending HostState intents that start or continue a turn. A pending draft
 * sync, rename or abort is not a run: counting it would pin a phantom on
 * screen for as long as the outbox holds it.
 */
const TURN_STARTING_INTENTS: ReadonlySet<string> = new Set([
  "message.enqueue",
  "turn.steer",
  "turn.followup",
])

function pendingIntentKind(payload: unknown): string | null {
  const actions = (payload as { actions?: unknown } | null)?.actions
  if (!Array.isArray(actions) || actions.length !== 1) return null
  const kind = (actions[0] as { action?: { kind?: unknown } } | null)?.action?.kind
  return typeof kind === "string" ? kind : null
}

/**
 * What the HostState replica says about `sessionId`'s turn, or `null` when no
 * Host owns this session's turn state on this device.
 *
 * The confirmed row is the Host's own word (the HostState stream keeps it
 * current, and a restarted Host settles every turn it left in flight before it
 * serves again). A send of this device's still waiting in the outbox is a turn
 * the Host has not confirmed yet, but will run.
 */
export async function probeHostStateRun(sessionId: string): Promise<RunLiveness | null> {
  const db = getDb()
  const channelSuffix = `/${encodeURIComponent(sessionId)}`
  const [rows, pending] = await Promise.all([
    db.hostStateChannels
      .filter((row) => row.state?.kind === "session" && row.state.sessionId === sessionId)
      .toArray(),
    db.mobileOutboundQueue
      .filter(
        (row) =>
          row.protocol === "host-state" &&
          typeof row.channel === "string" &&
          row.channel.endsWith(channelSuffix) &&
          (row.status === "pending" || row.status === "sending")
      )
      .toArray(),
  ])
  if (pending.some((row) => TURN_STARTING_INTENTS.has(pendingIntentKind(row.payload) ?? ""))) {
    return "alive"
  }
  if (rows.length === 0) return pending.length > 0 ? "unknown" : null
  return rows.some((row) => row.state.kind === "session" && LIVE_HOST_TURNS.has(row.state.turn))
    ? "alive"
    : "gone"
}

/** Load the in-realm liveness evidence and build the production deps. */
export async function createPhantomRunDeps(): Promise<PhantomRunDeps> {
  const [chatLease, directChat, roomHost, messages] = await Promise.all([
    import("@/lib/execution/chat-lease"),
    import("@/lib/execution/direct-chat-run"),
    import("@/lib/chat/room/runner-host"),
    import("@/lib/db/messages"),
  ])
  return {
    hasLocalRunHandle: (sessionId) =>
      chatLease.hasChatLease(sessionId) ||
      chatLease.isChatTurnQueued(sessionId) ||
      directChat.hasActiveDirectChatExecutionRun(sessionId) ||
      roomHost.isCompanionRoomActive(sessionId),
    probeHostRun: probeHostStateRun,
    commitMessages: (sessionId: string, upserts: UIMessage[]) =>
      upserts.length === 0
        ? Promise.resolve()
        : messages.commitMessageDelta(sessionId, { upserts }),
  }
}

/**
 * Install the guard against the real chat store. Safe to call during boot:
 * the evidence modules load asynchronously, and the returned disposer works
 * whether or not loading finished.
 */
export function installDefaultPhantomRunGuard(options: { graceMs?: number } = {}): () => void {
  let disposed = false
  let uninstall: (() => void) | null = null
  void (async () => {
    const [deps, { useChatStore }] = await Promise.all([
      createPhantomRunDeps(),
      import("@/stores/chat/chat-store"),
    ])
    if (disposed) return
    uninstall = installPhantomRunGuard({
      deps,
      store: useChatStore as unknown as PhantomRunStore,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    })
  })().catch((error: unknown) => console.warn("phantom run guard failed to install", error))
  return () => {
    disposed = true
    uninstall?.()
    uninstall = null
  }
}
