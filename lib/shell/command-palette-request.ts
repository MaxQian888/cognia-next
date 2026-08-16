/**
 * Ask the always-mounted command palette to open — optionally with a query
 * already typed — from anywhere in the shell.
 *
 * The palette owns its own state and listens for ⌘/Ctrl+K itself; surfaces
 * that wanted to open it (the title bar's search pill, its menus) each forged
 * that keystroke by hand. A keystroke cannot carry a query, and the
 * conversation rail's search now hands off to the palette for a global search
 * with the words the user has already typed, so this is the one seam both
 * sides agree on: a DOM event on `window`, no store, no import cycle between
 * the rail and the palette.
 */

import type { GlobalSearchScope } from "@/lib/global-search/types"

export const COMMAND_PALETTE_REQUEST_EVENT = "cognia:command-palette:request"

export interface CommandPaletteRequestDetail {
  /** Seed the palette's search field with this text (already-typed words). */
  query?: string
  /**
   * Open on this scope tab (ADR-0129): the settings shell asks for `pages`,
   * the conversation rail for `chats`. Omitted = the *All* tab.
   */
  scope?: GlobalSearchScope
}

export function requestCommandPalette(detail: CommandPaletteRequestDetail = {}): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_REQUEST_EVENT, { detail }))
}

/** Subscribe the palette; returns the unsubscribe. */
export function onCommandPaletteRequest(
  handler: (detail: CommandPaletteRequestDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CommandPaletteRequestDetail>).detail
    handler(detail && typeof detail === "object" ? detail : {})
  }
  window.addEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
}
