/**
 * Keyboard claims on native-menu accelerators.
 *
 * Under Tauri a handful of chords are native menu accelerators
 * (`src-tauri/src/menu.rs`): ⌘⇧P → `command-palette`, ⌘B → `toggle-sidebar`,
 * ⌘1 / ⌘2 → `go-inbox` / `go-workflows`. They reach the renderer as
 * `menu://<id>` events through `useMenuEventRouter`, which knows nothing about
 * focus — so pressing ⌘B inside the project editor toggled the conversation
 * sidebar and ⌘2 navigated away to Workflows, taking the user out of the file
 * they were editing.
 *
 * A focused surface that owns one of those chords records a claim from its
 * keydown instead of acting on it; the router takes the claim when the menu
 * event arrives and runs the surface's action in place of the app-level one.
 *
 * Why a keydown-stamped claim rather than "is focus inside the surface":
 * - A menu item picked with the mouse fires the same `menu://` event with no
 *   keydown, and it must keep its app meaning (View ▸ Toggle Sidebar is the
 *   conversation sidebar, Go ▸ Inbox navigates).
 * - The surface does not act on the keydown itself, so a menu event that
 *   arrives first (and does the app action) is never doubled by the surface.
 * - A platform whose webview swallows the accelerator before the menu sees it
 *   would leave the keystroke doing nothing; the claim therefore runs itself
 *   after {@link MENU_CLAIM_FALLBACK_MS} when no menu event took it. Menu IPC
 *   lands within a few milliseconds, far inside that window.
 */

import type { MenuActionId } from "./menu-actions"

/** How long a keydown claim stays valid while its menu event is in flight. */
export const MENU_CLAIM_WINDOW_MS = 1000

/** When no menu event has taken a claim by now, the claim runs itself. */
export const MENU_CLAIM_FALLBACK_MS = 400

interface PendingClaim {
  id: MenuActionId
  at: number
  run: () => void
}

let pending: PendingClaim | null = null

/**
 * Record that the keystroke for menu action `id` was pressed inside a surface
 * that handles it itself. A newer claim replaces an older one — only the
 * latest keystroke can still have a menu event in flight.
 */
export function claimNativeMenuAction(
  id: MenuActionId,
  run: () => void,
  options: { now?: number; fallbackMs?: number } = {}
): void {
  const claim: PendingClaim = { id, at: options.now ?? Date.now(), run }
  pending = claim
  setTimeout(() => {
    // Taken by the router, or superseded by a newer keystroke: nothing to do.
    if (pending !== claim) return
    pending = null
    claim.run()
  }, options.fallbackMs ?? MENU_CLAIM_FALLBACK_MS)
}

/**
 * Take the claim for `id`, if a fresh one is pending. Consumed on read so one
 * keystroke can redirect at most one menu event.
 */
export function takeNativeMenuClaim(
  id: MenuActionId,
  now: number = Date.now()
): (() => void) | null {
  const claim = pending
  if (claim === null || claim.id !== id) return null
  pending = null
  if (now - claim.at > MENU_CLAIM_WINDOW_MS) return null
  return claim.run
}

/** Test seam: drop any pending claim. */
export function __resetNativeMenuClaimsForTesting(): void {
  pending = null
}
