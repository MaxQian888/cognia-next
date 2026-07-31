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

import { endCodeAdoptionTurn } from "./client"
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
  workspaceRoot?: string
): CodeAdoptionTurnRow | null {
  if (!resources) return legacy
  const files = resources
    .filter((resource) => resource.origin === "agent" && resource.captureClass !== "generated")
    .map((resource) => ({
      path: resource.path,
      added: resource.insertions ?? 0,
      removed: resource.deletions ?? 0,
      isNew: resource.kind === "created",
      hunks: [] as Array<[number, number]>,
    }))
  return {
    id: `${sessionId}:${runId}`,
    runId,
    sessionId,
    workspaceRoot: legacy?.workspaceRoot ?? workspaceRoot ?? "",
    agentKind: legacy?.agentKind ?? "in-app",
    model: legacy?.model ?? null,
    ts: Date.now(),
    totalFiles: files.length,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
    files,
    truncated: false,
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
  const row = projectTaskResources(sessionId, runId, resources, legacy, active?.workspaceRoot)
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
