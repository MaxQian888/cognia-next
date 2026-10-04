"use client"

/**
 * Host handles for the `+` menu a capability row is mounted inside.
 *
 * Rows injected through `capabilities` (web search, skills, room target)
 * render inside whichever host owns the trigger — the desktop attach Popover
 * or the mobile plus-menu Drawer — and neither reaches back in. Two handles
 * cross that boundary:
 *
 * - **Close** ({@link useComposerMenuClose}). A row that LEAVES the menu (e.g.
 *   web search's unconfigured state, which navigates to Settings) needs the
 *   host to close behind it or the user returns to a stale panel; the menu's
 *   own rows get `closeMenu()` directly, injected rows read it here. No
 *   provider above means no menu to close — the default is a no-op.
 *
 * - **Panels** ({@link useComposerMenuPanels} / {@link ComposerMenuPanel}). A
 *   row that opens a second-level list (the skill picker, the room's member
 *   picker, web search's setup card) flies that list out as its own Popover on
 *   desktop. On the phone sheet a second floating layer over the sheet is the
 *   wrong shape — it overlaps the sheet, and a popover autofocuses its first
 *   field, which raises the soft keyboard before the user asked to type. The
 *   sheet instead DRILLS IN: it swaps its body for the panel, draws the panel's
 *   title and a back button in its own header, and slides between the two.
 *
 *   The row keeps owning its panel (its store reads, its session, its
 *   handlers): it renders the body inside `<ComposerMenuPanel id>`, which
 *   portals it into the host's slot while that panel is the one showing. The
 *   host keeps the root view mounted (hidden) while drilled in, so the row —
 *   and with it the portal — stays alive. A host without in-place navigation
 *   (the desktop Popover) provides nothing, `useComposerMenuPanels()` returns
 *   `null`, and the row falls back to its flyout.
 *
 *   A mounted `ComposerMenuPanel` registers its id with the host. A panel that
 *   stops rendering while it is showing (the room stopped being a team room,
 *   web search got configured) unregisters, and the host falls back to its
 *   root instead of showing an empty body under a stale title.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"

const ComposerMenuCloseContext = createContext<(() => void) | null>(null)

export const ComposerMenuCloseProvider = ComposerMenuCloseContext.Provider

export function useComposerMenuClose(): () => void {
  return useContext(ComposerMenuCloseContext) ?? (() => {})
}

/** In-place navigation a host menu offers its injected rows. */
export interface ComposerMenuPanels {
  /** Id of the injected panel the host is showing, `null` on any other view. */
  activePanelId: string | null
  /** Host-owned element the showing panel's body is portalled into. */
  slot: HTMLElement | null
  /**
   * Drill into the panel `id`. The host draws `title` and the back button in
   * its header; the body comes from the matching {@link ComposerMenuPanel}.
   */
  openPanel: (id: string, title: string) => void
  /** Back to the menu's root view (the sheet stays open). */
  closePanel: () => void
  /**
   * Announce that a panel body for `id` is mounted. Returns the unregister.
   * Must be referentially stable — {@link ComposerMenuPanel} re-registers when
   * it changes.
   */
  registerPanel: (id: string) => () => void
}

const ComposerMenuPanelsContext = createContext<ComposerMenuPanels | null>(null)

export const ComposerMenuPanelsProvider = ComposerMenuPanelsContext.Provider

/**
 * The host's in-place navigation, or `null` when the host has none (desktop
 * Popover, or no menu at all) — the caller then opens its own flyout.
 */
export function useComposerMenuPanels(): ComposerMenuPanels | null {
  return useContext(ComposerMenuPanelsContext)
}

/**
 * The body of an injected panel. Renders nothing until the host shows panel
 * `id`, then portals `children` into the host's slot. Render it next to the row
 * that opens it, under a host that provides {@link ComposerMenuPanelsProvider}.
 */
export function ComposerMenuPanel({ id, children }: { id: string; children: ReactNode }) {
  const panels = useComposerMenuPanels()
  const registerPanel = panels?.registerPanel
  useEffect(() => registerPanel?.(id), [registerPanel, id])
  if (!panels || panels.activePanelId !== id || !panels.slot) return null
  return createPortal(children, panels.slot)
}
