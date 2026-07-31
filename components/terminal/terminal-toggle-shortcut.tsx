"use client"

/**
 * Registers the rebindable `terminal.toggle` shortcut (default Ctrl/Cmd + `)
 * that toggles the integrated terminal dock. Still a headless client component
 * mounted by the desktop shell, but the window listener, the `platform.tauri`
 * gate, the editable-target guard, and the plugin `dispatchShortcut` notify are
 * now owned by the single `use-app-shortcut-dispatcher` (the descriptor carries
 * `when: "platform.tauri"`, so it never fires in the web/Capacitor shells that
 * have no PTY).
 *
 * Why this stays app-scope (renderer-local) and not an OS-global registration:
 * VS Code's Ctrl+` fires only when the app has focus; a global registration
 * would seize the chord while another app is foreground.
 */

import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export function TerminalToggleShortcut() {
  useAppShortcut(
    "terminal.toggle",
    () => {
      useTerminalStore.getState().togglePanel()
    },
    { preventDefault: true }
  )
  return null
}

export default TerminalToggleShortcut
