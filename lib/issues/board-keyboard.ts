/**
 * Keyboard navigation for a kanban board's drag.
 *
 * dnd-kit's `sortableKeyboardCoordinates` assumes one sortable list. This board
 * is six of them side by side, with a tall column droppable wrapping each — and
 * on that shape it misreads left/right entirely: it ranks every droppable by
 * corner distance, the column rects are full-height, and the winner ends up
 * being whichever column's corner happens to be nearest rather than the one
 * next door. Observed live: picking a card up in `todo` immediately reported
 * `canceled` as the target, and the arrow keys never changed it.
 *
 * So horizontal movement is resolved here, against the COLUMNS in the order
 * the caller lays them out, which is what "the next column" means to anyone
 * looking at the board. Generic over the column key so `/issues` and the
 * Squad task board share it through `components/board/kanban-board.tsx`.
 * Vertical movement stays dnd-kit's — within a column it is an ordinary
 * sortable list and its own getter is right.
 *
 * Pure, and rect-shaped rather than DOM-shaped, so the traversal is testable
 * without a browser.
 */

export interface BoardRect {
  left: number
  top: number
  width: number
  height: number
}

/** Left inset of a column's card area (`px-2` on the body). */
const COLUMN_CARD_INSET = 8

/** Height of the column header, so a card never lands on top of it. */
const COLUMN_HEADER_HEIGHT = 44

function centerX(rect: BoardRect): number {
  return rect.left + rect.width / 2
}

/**
 * Which column the dragged card is currently over.
 *
 * Containment first, because that is unambiguous while the card is inside a
 * column; nearest-centre only as the fallback for a card held in the gap
 * between two.
 */
export function currentBoardColumn<K>(
  collisionRect: BoardRect,
  columnRects: ReadonlyMap<K, BoardRect>
): K | null {
  const x = centerX(collisionRect)
  let nearest: { status: K; distance: number } | null = null

  for (const [status, rect] of columnRects) {
    if (x >= rect.left && x <= rect.left + rect.width) return status
    const distance = Math.abs(centerX(rect) - x)
    if (!nearest || distance < nearest.distance) nearest = { status, distance }
  }
  return nearest?.status ?? null
}

/**
 * Where the card should go for one press of Left or Right.
 *
 * Returns null at either end of the board rather than wrapping: running off the
 * last column and reappearing at the first loses the user's place, and a drag
 * is exactly when that hurts.
 *
 * The vertical position is carried across and clamped into the target column,
 * so crossing the board does not also throw the card to the top.
 */
export function nextBoardColumnCoordinates<K>(
  direction: "left" | "right",
  collisionRect: BoardRect,
  columnRects: ReadonlyMap<K, BoardRect>,
  order: readonly K[]
): { x: number; y: number } | null {
  const current = currentBoardColumn(collisionRect, columnRects)
  if (current === null) return null

  const step = direction === "right" ? 1 : -1
  let index = order.indexOf(current) + step

  while (index >= 0 && index < order.length) {
    const target = columnRects.get(order[index])
    if (target) {
      const minTop = target.top + COLUMN_HEADER_HEIGHT
      const maxTop = Math.max(minTop, target.top + target.height - collisionRect.height)
      return {
        x: target.left + COLUMN_CARD_INSET,
        y: Math.min(Math.max(collisionRect.top, minTop), maxTop),
      }
    }
    index += step
  }
  return null
}
