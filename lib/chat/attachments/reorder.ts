/**
 * Pure reorder decision for composer attachment chips.
 *
 * Kept out of the component — same split as `lib/chat/conversation-dnd.ts` —
 * so the "where does the dragged chip land" rule is unit-testable without
 * mounting a @dnd-kit sensor tree.
 */

/**
 * Move `activeId` into `overId`'s slot, shifting the rest. Returns the input
 * array unchanged (same reference) when the move is a no-op or either id is
 * unknown, so callers can use it directly in a setState updater without
 * forcing a re-render.
 */
export function reorderIds(
  ids: readonly string[],
  activeId: string,
  overId: string
): readonly string[] {
  if (activeId === overId) return ids
  const from = ids.indexOf(activeId)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, activeId)
  return next
}

/**
 * Order `items` by `order`, appending anything `order` doesn't mention.
 *
 * The order list and the live attachment list are updated by different owners
 * (this module vs. the vendored `PromptInputProvider`), so they can be briefly
 * out of sync — a file added microseconds ago is in `items` but not yet in
 * `order`. Appending the remainder keeps a freshly-staged chip visible instead
 * of dropping it for a frame.
 */
export function applyOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[]
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      ordered.push(item)
      byId.delete(id)
    }
  }
  for (const item of items) {
    if (byId.has(item.id)) ordered.push(item)
  }
  return ordered
}

/**
 * Whether a finished drag should commit, and onto what.
 *
 * Split out of the component for the same reason as `lib/chat/conversation-dnd.ts`:
 * jsdom gives every element a 0×0 box, so @dnd-kit can never resolve a drop
 * target there and the branch would otherwise be untestable. Returns the target
 * id to reorder onto, or null when the drag was cancelled, dropped outside, or
 * landed back on itself.
 */
export function resolveDragEnd(activeId: string, overId: string | null | undefined): string | null {
  if (!overId || activeId === overId) return null
  return overId
}
