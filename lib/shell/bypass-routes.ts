/**
 * Routes that render full-bleed, with no app chrome around them.
 *
 * These are deep-link / overlay screens: the mobile pairing flow, OAuth
 * callbacks, the share target, a canvas join link, and the small frameless
 * Tauri windows (pet overlay/popup, island, selection toolbar, tray panel,
 * skill-recorder controller strip). They own the whole viewport and keep the
 * document scroll, so anything the shells normally paint around a route — rail,
 * title bar, tab bar, persistent notices — must not appear on them.
 *
 * Lives in `lib/` rather than next to `DesktopAppShell` because the list has
 * two kinds of consumer now: the shells that skip their chrome, and chrome
 * pieces that self-hide (`FinishSetupBar`). Importing it back out of the
 * desktop shell would make those two a cycle.
 */
const BYPASS_PREFIXES = [
  "/share-target",
  "/pair",
  "/oauth",
  "/canvas/join",
  "/pet-overlay",
  "/pet-popup",
  "/island",
  "/selection-toolbar",
  "/tray-panel",
  "/recorder-controller",
]

export function isShellBypassRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return BYPASS_PREFIXES.some(
    (p) => pathname === p || pathname === `${p}.html` || pathname.startsWith(p + "/")
  )
}
