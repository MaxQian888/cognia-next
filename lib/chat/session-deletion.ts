import { loggers } from "@cognia/logging"
import { closeSession } from "@/lib/claude/ipc"
import { bulkDeleteSessions } from "@/lib/db/sessions"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { useImNotifyStore } from "@/stores/chat/im-notify-store"

/**
 * Delete conversations on THIS device, with the full teardown a delete owes.
 *
 * One routine for both places a delete is carried out: the chat UI deleting
 * locally (`hooks/chat/use-sessions.ts`, when no Host takes the write) and the
 * Host applying a paired client's `session.delete` intent
 * (`lib/sync/host-state-service.ts`). Before the Host path existed the steps
 * lived only in the hook, so a remote delete would have dropped the rows while
 * leaving the sidecar session running, the IM notify armed, plugins unaware,
 * and the Host's own chat pane showing a conversation that no longer existed.
 *
 * Order matters:
 * 1. Close each live sidecar session first. Per-id failures are tolerated —
 *    the sidecar may simply not be tracking that id.
 * 2. Run the Dexie cascade (`bulkDeleteSessions`). It re-checks the handoff
 *    lock for every row and its owned descendants and throws
 *    `SessionHandoffLockedError` before touching anything, so a refused delete
 *    leaves every row intact and the error reaches the caller.
 * 3. Only after the commit: disarm IM notifications, announce the deletion on
 *    the plugin bus (ids only — PII red line), and deselect the active session
 *    if it was one of them.
 */
export async function deleteSessionsWithTeardown(ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return
  if (isTauri()) {
    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          await closeSession(id)
        } catch (error) {
          // Non-fatal — the sidecar may not have a session for this id.
          loggers.store.warn("closeSession failed", { sessionId: id, error: String(error) })
        }
      })
    )
  }
  await bulkDeleteSessions(uniqueIds)
  const notify = useImNotifyStore.getState()
  for (const id of uniqueIds) {
    // A deleted session can never settle — drop its armed entry rather than
    // waiting for the registry's age cap to evict it.
    notify.disarmSession(id)
    emitSystemBusEvent(SystemEvents.SESSION_DELETED, { sessionId: id })
  }
  const chat = useChatStore.getState()
  if (chat.activeSessionId && uniqueIds.includes(chat.activeSessionId)) {
    chat.setActiveSession(null)
  }
}
