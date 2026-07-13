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

import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat/chat-store"
import type { ChatStatus } from "@/stores/chat/chat-store"

import { endCodeAdoptionTurn } from "./client"
import { persistCodeAdoptionTurn, pruneCodeAdoptionTurns } from "./persist"

/** A turn ends when a running status transitions to a terminal one. */
export function isSettleEdge(before: ChatStatus | undefined, now: ChatStatus): boolean {
  if (before !== "streaming" && before !== "awaiting_approval") return false
  return now === "idle" || now === "error"
}

/** Best-effort: reconcile a settled turn, persist its record, and bound growth. */
async function settleTurn(sessionId: string, runId: number): Promise<void> {
  const row = await endCodeAdoptionTurn(`${sessionId}:${runId}`)
  if (!row) return
  await persistCodeAdoptionTurn(row)
  await pruneCodeAdoptionTurns()
}

/**
 * Subscribe to chat-store status edges and persist each settled turn's
 * attribution. Returns an unsubscribe. No-op (returns a noop) off-Tauri.
 */
export function startCodeAdoptionTracker(): () => void {
  if (!isTauri()) return () => {}
  return useChatStore.subscribe((state, prev) => {
    for (const sessionId of Object.keys(state.sessions)) {
      const slice = state.sessions[sessionId]
      const before = prev.sessions[sessionId]?.status
      if (!isSettleEdge(before, slice.status)) continue
      void settleTurn(sessionId, slice.runId).catch(() => {})
    }
  })
}
