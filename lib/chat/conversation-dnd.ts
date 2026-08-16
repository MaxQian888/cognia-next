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

import { conversationSectionKey, type ConversationSection } from "./conversation-list-model"

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

/**
 * A reorder the user just dropped, held on screen until the store catches up.
 *
 * The persisted order arrives through a live query a few frames after the
 * drop. Without a projection, @dnd-kit resets its transforms first, so every
 * row glides *back* to its pre-drop slot and the real reorder then lands as an
 * instant DOM swap — with two similar-looking rows that reads as "nothing
 * happened". Applying the dropped order synchronously lets the drop animation
 * carry the row into the slot it will keep.
 */
export interface PendingReorder {
  /** `conversationSectionKey` of the section the drop happened in. */
  sectionKey: string
  /** That section's ids as the *store* had them at drop time — the snapshot the projection overrides. */
  baseIds: readonly string[]
  /** The order the user dropped, and the store is about to persist. */
  ids: readonly string[]
}

export type PendingReorderStatus =
  /** No pending reorder. */
  | "idle"
  /** The store still shows the pre-drop snapshot; the dropped order is projected over it. */
  | "applied"
  /** The store now carries the dropped order — the projection has become a no-op. */
  | "settled"
  /**
   * The store moved somewhere else (the section is gone, its membership changed,
   * or another writer reordered it). The snapshot no longer holds, so the
   * projection must be dropped rather than override a truth it never saw.
   */
  | "stale"

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Project a {@link PendingReorder} onto the model's sections. Pure and cheap
 * (one pass over one section), so the component derives the displayed
 * sections from it every render and clears the pending reorder as soon as the
 * status stops being `"applied"`.
 */
export function projectPendingReorder<S extends ConversationSection>(
  sections: readonly S[],
  pending: PendingReorder | null
): { sections: readonly S[]; status: PendingReorderStatus } {
  if (!pending) return { sections, status: "idle" }
  const index = sections.findIndex(
    (section) => conversationSectionKey(section) === pending.sectionKey
  )
  if (index === -1) return { sections, status: "stale" }
  const section = sections[index]!
  const currentIds = section.sessions.map((s) => s.id)
  if (sameOrder(currentIds, pending.ids)) return { sections, status: "settled" }
  if (!sameOrder(currentIds, pending.baseIds)) return { sections, status: "stale" }
  const byId = new Map(section.sessions.map((s) => [s.id, s]))
  // A dropped order is a permutation of the snapshot by construction
  // (`resolveConversationDrop`); anything else cannot be projected honestly.
  if (pending.ids.length !== byId.size || !pending.ids.every((id) => byId.has(id))) {
    return { sections, status: "stale" }
  }
  const projected = sections.slice()
  projected[index] = { ...section, sessions: pending.ids.map((id) => byId.get(id)!) }
  return { sections: projected, status: "applied" }
}
