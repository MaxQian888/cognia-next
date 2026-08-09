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
  const active = useTaskWorkspaceStore.getState().activeBySession[sessionId]
  const resources = await settleTaskWorkspaceTurn(
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
 * Subscribe to chat-store status edges and persist each settled turn's
 * attribution. Returns an unsubscribe. No-op (returns a noop) off-Tauri.
 */
export function startCodeAdoptionTracker(): () => void {
  return useChatStore.subscribe((state, prev) => {
    for (const sessionId of Object.keys(state.sessions)) {
      const slice = state.sessions[sessionId]
      const before = prev.sessions[sessionId]?.status
      if (!isSettleEdge(before, slice.status)) continue
      void settleTurn(sessionId, slice.runId, slice.status).catch(() => {})
    }
  })
}
