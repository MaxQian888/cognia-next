"use client"

/**
 * Window-local Ctrl/Cmd + ` shortcut that toggles the integrated
 * terminal dock. Direct mirror of `components/desktop/zoom-shortcuts.tsx`:
 *
 *   * headless `"use client"` component, no rendered output,
 *   * `window.addEventListener("keydown", …)` runs in the React effect
 *     so it lives only while the dock-bearing shell is mounted,
 *   * fires `dispatchShortcut("terminal.toggle")` for plugins to react,
 *   * gated behind `isTauri()` — the dock has no equivalent in the web
 *     shell (no PTY) or in Capacitor (LAN-only path is task #14).
 *
 * Why window-local instead of the OS-global `ShortcutRegistry`:
 *   * VS Code's Ctrl+` is window-local — fires only when the app has
 *     focus. The global registry would seize the chord while another
 *     app is foreground.
 *   * The chord parser in `src-tauri/src/shortcuts/registry.rs` does
 *     not whitelist Backquote in `code_from_part`. We deliberately
 *     don't extend that whitelist for v1.
 */

import { useEffect } from "react"

import { getPluginEventHooks } from "@/lib/plugin"
import { isTauri } from "@/lib/tauri"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export function TerminalToggleShortcut() {
  useEffect(() => {
    if (!isTauri()) return

    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      if (event.key !== "`") return
      // Avoid stealing the chord from text inputs — backtick is a
      // legitimate keystroke inside code editors / chat composers.
      // We check the attribute directly because jsdom doesn't implement
      // the `isContentEditable` getter the same way as browsers.
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        const contentEditable =
          target.isContentEditable ||
          target.getAttribute?.("contenteditable") === "true" ||
          target.getAttribute?.("contenteditable") === ""
        if (tag === "INPUT" || tag === "TEXTAREA" || contentEditable) {
          return
        }
      }
      event.preventDefault()
      void getPluginEventHooks().dispatchShortcut("terminal.toggle")
      useTerminalStore.getState().togglePanel()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  return null
}

export default TerminalToggleShortcut
