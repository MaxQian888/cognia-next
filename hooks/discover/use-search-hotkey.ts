"use client"

/**
 * Global `/` shortcut that focuses a search input — the same convention used by
 * GitHub, Slack, and Linear. Registers a window `keydown` listener while
 * mounted and focuses `ref` when the user presses `/` outside any text field.
 *
 * Guards:
 *  - Ignored when a modifier (⌘ / Ctrl / Alt) is held so it never shadows
 *    browser shortcuts.
 *  - Ignored when the event originates from an `<input>` / `<textarea>` /
 *    contenteditable, so typing a literal "/" into a field still works.
 *  - `preventDefault()` on match so the "/" isn't also inserted once focus lands.
 */

import { useEffect, type RefObject } from "react"

export function useSearchHotkey(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return
      const input = ref.current
      if (!input) return
      event.preventDefault()
      input.focus()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [ref])
}
