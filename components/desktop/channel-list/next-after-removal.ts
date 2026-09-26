/**
 * Which conversation to open when the open one leaves the list.
 *
 * Deleting or archiving the conversation on screen used to drop the user on
 * the welcome screen — the list lost its place along with the row. This picks
 * the row that takes its slot instead: the next one below in the rendered
 * order that is not itself being removed, else the nearest one above (the
 * removed row was last), else nothing (the list is empty afterwards).
 *
 * `null` too when the open conversation is not among the removed rows, or is
 * not in the rendered order (a filter, a collapsed group or a "Show more" cut
 * hides it) — then removing rows elsewhere has nothing to hand over.
 */
export function nextAfterRemoval(
  renderedOrder: readonly string[],
  removedIds: ReadonlySet<string>,
  activeSessionId: string | null
): string | null {
  if (!activeSessionId || !removedIds.has(activeSessionId)) return null
  const index = renderedOrder.indexOf(activeSessionId)
  if (index < 0) return null
  for (let i = index + 1; i < renderedOrder.length; i += 1) {
    const id = renderedOrder[i]!
    if (!removedIds.has(id)) return id
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const id = renderedOrder[i]!
    if (!removedIds.has(id)) return id
  }
  return null
}
