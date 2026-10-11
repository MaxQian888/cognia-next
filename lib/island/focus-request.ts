/**
 * Route a click on another surface to one island row (ADR-0225 §1).
 *
 * The island is the desktop's Agent Fleet: approvals, answers and per-task
 * stops happen there and nowhere else. When the tray panel's Fleet summary is
 * clicked, the main window opens the island (if it is not already open) and
 * asks it to pin that row, which is what reveals the row's controls.
 *
 * A freshly opened island has not mounted its listeners yet, so a focus sent
 * immediately would be lost. Instead the request is parked here, and the
 * island initializer hands it over right after it answers the island's
 * mount-time state request. A parked focus expires: if the island never asks
 * (it failed to open, or the user closed it), a much later reopen must not
 * suddenly jump to a row the user clicked minutes ago.
 */

export const ISLAND_FOCUS_PENDING_MS = 5_000

let pending: { rowId: string; expiresAt: number } | null = null

export interface IslandFocusDeps {
  isOpen: () => Promise<boolean>
  open: () => Promise<boolean>
  send: (rowId: string) => Promise<boolean>
  now: () => number
}

/**
 * Open the island on a row. Resolves true when the island is open and the
 * focus was delivered or parked for its mount; false when it could not open.
 */
export async function requestIslandFocus(
  rowId: string | null,
  deps: IslandFocusDeps
): Promise<boolean> {
  if (await deps.isOpen()) {
    pending = null
    if (rowId) await deps.send(rowId)
    return true
  }
  pending = rowId ? { rowId, expiresAt: deps.now() + ISLAND_FOCUS_PENDING_MS } : null
  const opened = await deps.open()
  if (!opened) pending = null
  return opened
}

/** Take the parked focus, if it has not expired. Clears it either way. */
export function takePendingIslandFocus(now: number): string | null {
  const parked = pending
  pending = null
  return parked && parked.expiresAt > now ? parked.rowId : null
}

/** Test seam. */
export function __resetIslandFocusForTesting(): void {
  pending = null
}
