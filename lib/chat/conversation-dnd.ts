/**
 * Pure drag-drop resolution for the conversation sidebar (ChannelList). Keeps
 * the @dnd-kit wiring in the component thin and the decision logic testable.
 *
 * Two gestures are supported:
 *  - Drop a conversation onto a folder header → assign it to that folder.
 *  - Drop a conversation onto another conversation in the same section →
 *    reorder that section (Pinned, a date bucket, a folder, or the flat
 *    "recent" list). Both rows must belong to the same section; dropping across
 *    sections (e.g. between two date buckets) has no manual-order meaning.
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

export interface ConversationDropPreview {
  targetId: string
  position: "before" | "after"
}

/**
 * Resolve the insertion edge to show while a sortable row is hovering another
 * row. The cue is intentionally limited to a single section, matching the
 * persistence rule in {@link resolveConversationDrop}.
 */
export function resolveConversationDropPreview(
  activeId: string,
  overId: string,
  siblingIds: readonly string[]
): ConversationDropPreview | null {
  if (activeId === overId) return null
  const from = siblingIds.indexOf(activeId)
  const to = siblingIds.indexOf(overId)
  if (from === -1 || to === -1) return null
  return {
    targetId: overId,
    position: from < to ? "after" : "before",
  }
}

/**
 * Resolve a drag-end into a concrete action, or `null` for a no-op.
 *
 * @param active     the dragged node (always a session row)
 * @param over       the drop target, or null when dropped on nothing
 * @param siblingIds current render order of the section the drop target lives
 *                   in. A reorder only happens when the dragged row also
 *                   belongs to it (same-section constraint).
 */
export function resolveConversationDrop(
  active: DndNode | null,
  over: DndNode | null,
  siblingIds: readonly string[]
): ConversationDropAction | null {
  if (!active || !over || active.id === over.id) return null

  // Dropped onto a folder header → (re)assign membership.
  if (over.data?.type === "folder") {
    const folderId = over.data.folderId ?? null
    // No-op if it's already in that folder.
    if (active.data?.folderId === folderId) return null
    return { type: "assign", sessionId: active.id, folderId }
  }

  // Dropped onto another row in the same section → reorder that section. Both
  // ends must be present in `siblingIds`; dragging a row from one section onto
  // a row in another (e.g. across date buckets) has no manual-order meaning.
  const from = siblingIds.indexOf(active.id)
  const to = siblingIds.indexOf(over.id)
  if (from === -1 || to === -1) return null

  const ids = [...siblingIds]
  ids.splice(from, 1)
  ids.splice(to, 0, active.id)
  return { type: "reorder", ids }
}
