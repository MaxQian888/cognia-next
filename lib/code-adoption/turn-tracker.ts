/**
 * The single boot-wired seam that closes each in-app turn's attribution window.
 *
 * `beginCodeAdoptionTurn` is called explicitly at the turn-start choke point
 * (`hooks/chat/use-claude-chat.ts`, where cwd/model are in scope). The *end* of
 * a turn, by contrast, settles at several call sites, so instead of touching
 * each we subscribe to the chat store's status machine and fire `endTurn` on
 * the settle edge (`streaming | awaiting_approval → idle | error`). `runId` at
 * the settle edge is still the ending turn's id — it only bumps on the next
 * idle→streaming edge (`chat-store.ts:statusPatch`).
 */

import { settleTaskWorkspaceTurn } from "@/lib/task-workspace/client"
import { useChatStore } from "@/stores/chat/chat-store"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import type { ChatStatus } from "@/stores/chat/chat-store"

import {
  consumeCodeAdoptionTrackingAttempt,
  endCodeAdoptionTurn,
  type TrackingAttempt,
} from "./client"
import { persistCodeAdoptionTurn, pruneCodeAdoptionTurns } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

const cancelledTaskWorkspaceTurns = new Set<string>()

export function markTaskWorkspaceTurnCancelled(sessionId: string, runId: number): void {
  cancelledTaskWorkspaceTurns.add(`${sessionId}:${runId}`)
}

/**
 * Turns that ended without ever acquiring the session's managed working copy.
 *
 * The settle edge releases whatever `activeBySession[sessionId]` holds, and
 * that is deliberately not compared against the ending turn's identity — see
 * `settleTaskWorkspaceTurn`. For a turn that ran, that is right: the session's
 * open run IS the one it opened.
 *
 * A turn that was REFUSED the working copy breaks that equivalence. Its own
 * `openWorkspaceBundleTurnLease` never returned, so `activeBySession` still
 * holds the PREVIOUS turn's run — and the refusal's status edge would settle
 * it. That turn is very often the reason the refusal happened at all, which
 * means a send that arrived while an earlier turn was legitimately mid-flight
 * would tear that turn's working copy out from under it: the agent kept
 * streaming into a conversation whose execution root had already been settled
 * and whose diff was captured early.
 *
 * A turn that never owned a run has nothing to settle, so it says so.
 */
const unownedTaskWorkspaceTurns = new Set<string>()

/**
 * Declare that this turn ended without holding the session's workspace run, so
 * its settle edge releases nothing.
 *
 * Marked at the refusal, not inferred at the edge: by the time the edge fires,
 * "no run of my own" and "a run I have already forgotten" look identical from
 * the store.
 */
export function markTaskWorkspaceTurnUnowned(sessionId: string, runId: number): void {
  unownedTaskWorkspaceTurns.add(`${sessionId}:${runId}`)
}

function projectTaskResources(
  sessionId: string,
  runId: number,
  resources: Awaited<ReturnType<typeof settleTaskWorkspaceTurn>>,
  legacy: CodeAdoptionTurnRow | null,
  workspaceRoot?: string,
  taskWorkspaceRunId?: string,
  attempt?: TrackingAttempt
): CodeAdoptionTurnRow | null {
  if (!resources) {
    if (legacy) {
      return {
        ...legacy,
        measurement: "legacyFingerprint",
        trackingState: legacy.truncated ? "truncated" : "tracked",
        adoptionState: "notApplicable",
        proposedFiles: legacy.totalFiles,
        proposedAdded: legacy.totalAdded,
        proposedRemoved: legacy.totalRemoved,
        acceptedFiles: 0,
        acceptedAdded: 0,
        acceptedRemoved: 0,
      }
    }
    if (!attempt) return null
    return {
      id: `${sessionId}:${runId}`,
      runId,
      sessionId,
      workspaceRoot: attempt.cwd,
      agentKind: attempt.agentKind,
      model: attempt.model,
      ts: Date.now(),
      totalFiles: 0,
      totalAdded: 0,
      totalRemoved: 0,
      files: [],
      truncated: false,
      measurement: "legacyFingerprint",
      trackingState: "unavailable",
      trackingReason: attempt.reason ?? "reconcileFailed",
      adoptionState: "notApplicable",
      proposedFiles: 0,
      proposedAdded: 0,
      proposedRemoved: 0,
      acceptedFiles: 0,
      acceptedAdded: 0,
      acceptedRemoved: 0,
    }
  }
  const files = resources
    .filter((resource) => resource.origin === "agent" && resource.captureClass !== "generated")
    .map((resource) => ({
      path: resource.path,
      added: resource.insertions ?? 0,
      removed: resource.deletions ?? 0,
      isNew: resource.kind === "created",
      hunks: [] as Array<[number, number]>,
      acceptedAdded: 0,
      acceptedRemoved: 0,
      adoptionState: "pending" as const,
    }))
  return {
    id: `${sessionId}:${runId}`,
    runId,
    sessionId,
    ...(taskWorkspaceRunId ? { taskWorkspaceRunId } : {}),
    workspaceRoot: legacy?.workspaceRoot ?? workspaceRoot ?? "",
    agentKind: legacy?.agentKind ?? attempt?.agentKind ?? "in-app",
    model: legacy?.model ?? attempt?.model ?? null,
    ts: Date.now(),
    totalFiles: files.length,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
    files,
    truncated: false,
    measurement: "taskWorkspace",
    trackingState: "tracked",
    adoptionState: "pending",
    proposedFiles: files.length,
    proposedAdded: files.reduce((sum, file) => sum + file.added, 0),
    proposedRemoved: files.reduce((sum, file) => sum + file.removed, 0),
    acceptedFiles: 0,
    acceptedAdded: 0,
    acceptedRemoved: 0,
  }
}

/** A turn ends when a running status transitions to a terminal one. */
export function isSettleEdge(before: ChatStatus | undefined, now: ChatStatus): boolean {
  if (before !== "streaming" && before !== "awaiting_approval") return false
  return now === "idle" || now === "error"
}

/** Best-effort: reconcile a settled turn, persist its record, and bound growth. */
async function settleTurn(sessionId: string, runId: number, status: ChatStatus): Promise<void> {
  const turnKey = `${sessionId}:${runId}`
  const cancelled = cancelledTaskWorkspaceTurns.delete(turnKey)
  const unowned = unownedTaskWorkspaceTurns.delete(turnKey)
  const active = useTaskWorkspaceStore.getState().activeBySession[sessionId]
  const resources = unowned
    ? null
    : await settleTaskWorkspaceTurn(
        sessionId,
        runId,
        cancelled ? "cancelled" : status === "error" ? "failed" : "ready"
      )
  const legacy = await endCodeAdoptionTurn(turnKey)
  const attempt = consumeCodeAdoptionTrackingAttempt(turnKey)
  const row = projectTaskResources(
    sessionId,
    runId,
    resources,
    legacy,
    active?.workspaceRoot,
    active?.runId,
    attempt
  )
  if (!row) return
  await persistCodeAdoptionTurn(row)
  await pruneCodeAdoptionTurns()
}

/**
 * The one live subscription, and how many initializers are holding it open.
 *
 * Two chunks mount `CodeAdoptionTrackerInitializer`: the core-chat one and the
 * workflow-automation one. Outside development `resolveBootProfile` answers
 * `eager`, which requests every capability, so BOTH render and this was called
 * twice. Two closures in the store's listener set means `settleTurn` ran twice
 * per settle edge, and the marks it consumes are `Set.delete` — the first
 * subscriber took the mark and the second, seeing none, did exactly the thing
 * the mark exists to prevent: `markTaskWorkspaceTurnUnowned` lost its skip and
 * the previous, still-live turn's working copy was settled; and before that
 * `markTaskWorkspaceTurnCancelled` lost its `cancelled`, so an interrupted turn
 * was settled once as cancelled and once as ready.
 *
 * The core-chat mount's own comment already asserted this is idempotent and
 * "subscribes once". It was not. Refcounting is what makes that true, and it
 * keeps holding for a third mount rather than for one particular pair.
 */
let subscription: { stop: () => void; holders: number } | null = null

/**
 * Subscribe to chat-store status edges, settle each ended turn's managed
 * working copy, and persist its attribution. Returns a release function.
 *
 * Idempotent: repeated calls share one store subscription and the last release
 * detaches it. NOT host-gated, despite what this comment used to say — it is
 * the only caller of `settleTaskWorkspaceTurn`, so a host where it did not run
 * would leave every chat turn's run `running` and refuse that conversation's
 * next send for good.
 */
export function startCodeAdoptionTracker(): () => void {
  const held = (subscription ??= { stop: subscribeToSettleEdges(), holders: 0 })
  held.holders += 1
  let released = false
  return () => {
    if (released) return
    released = true
    held.holders -= 1
    if (held.holders > 0) return
    held.stop()
    // Only if this is still the live one: a release arriving after a later
    // start must not detach that one's subscription.
    if (subscription === held) subscription = null
  }
}

function subscribeToSettleEdges(): () => void {
  return useChatStore.subscribe((state, prev) => {
    for (const sessionId of Object.keys(state.sessions)) {
      const slice = state.sessions[sessionId]
      const before = prev.sessions[sessionId]?.status
      if (!isSettleEdge(before, slice.status)) continue
      void settleTurn(sessionId, slice.runId, slice.status).catch((error: unknown) => {
        // The only subscriber to this edge, so a throw here is the last chance
        // anything hears that a turn did not close out. Swallowed silently, its
        // one downstream symptom was the session's next send being refused for
        // a reason that named neither this turn nor this failure.
        console.error("code adoption turn settle failed", { sessionId, runId: slice.runId }, error)
      })
    }
  })
}
