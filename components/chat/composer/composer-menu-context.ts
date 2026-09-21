"use client"

/**
 * Close handle for the `+` menu a capability row is mounted inside.
 *
 * Rows injected through `capabilities` (web search, skills, room target)
 * render inside whichever host owns the trigger — the desktop attach Popover
 * or the mobile plus-menu Drawer — and neither reaches back in. A row that
 * LEAVES the menu (e.g. web search's unconfigured state, which navigates to
 * Settings) needs the host to close behind it or the user returns to a stale
 * panel; the menu's own rows get `closeMenu()` directly, injected rows read
 * it here. No provider above means no menu to close — the default is a no-op.
 */

import { createContext, useContext } from "react"

const ComposerMenuCloseContext = createContext<(() => void) | null>(null)

export const ComposerMenuCloseProvider = ComposerMenuCloseContext.Provider

export function useComposerMenuClose(): () => void {
  return useContext(ComposerMenuCloseContext) ?? (() => {})
}
