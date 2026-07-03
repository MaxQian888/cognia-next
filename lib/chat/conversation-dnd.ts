/**
 * Pure drag-drop resolution for the conversation sidebar (ChannelList). Keeps
 * the @dnd-kit wiring in the component thin and the decision logic testable.
 *
 * Two gestures are supported:
 *  - Drop a conversation onto a folder header → assign it to that folder.
 *  - Drop a pinned conversation onto another pinned conversation → reorder the
 *    Pinned section (recency ordering is otherwise automatic, so manual order
 *    only applies to pinned rows).
 */

/** Minimal shape of a @dnd-kit draggable/droppable identifier + payload. */
export interface DndNode {
  id: string
  data?: {
    /** "session" for a conversation row, "folder" for a folder drop target. */
    type?: "session" | "folder"
    /** Folder id (for `type: "folder"`) or the session's current folder. */
    folderId?: string | null
  }
}

export type ConversationDropAction =
  | { type: "assign"; sessionId: string; folderId: string | null }
  | { type: "reorder"; ids: string[] }

/**
 * Resolve a drag-end into a concrete action, or `null` for a no-op.
 *
 * @param active   the dragged node (always a session row)
 * @param over     the drop target, or null when dropped on nothing
 * @param pinnedIds current render order of the Pinned section
 */
export function resolveConversationDrop(
  active: DndNode | null,
  over: DndNode | null,
  pinnedIds: readonly string[]
): ConversationDropAction | null {
  if (!active || !over || active.id === over.id) return null

  // Dropped onto a folder header → (re)assign membership.
  if (over.data?.type === "folder") {
    const folderId = over.data.folderId ?? null
    // No-op if it's already in that folder.
    if (active.data?.folderId === folderId) return null
    return { type: "assign", sessionId: active.id, folderId }
  }

  // Dropped onto another pinned row → reorder within the Pinned section. Both
  // ends must be pinned; dragging a pinned row onto a non-pinned one (or vice
  // versa) has no manual-order meaning.
  const from = pinnedIds.indexOf(active.id)
  const to = pinnedIds.indexOf(over.id)
  if (from === -1 || to === -1) return null

  const ids = [...pinnedIds]
  ids.splice(from, 1)
  ids.splice(to, 0, active.id)
  return { type: "reorder", ids }
}
