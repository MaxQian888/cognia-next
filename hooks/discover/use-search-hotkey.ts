"use client"

/**
 * Global `/` shortcut that focuses a search input — the GitHub/Slack/Linear
 * convention. Registers the rebindable `app.search.focus` action; the single
 * `use-app-shortcut-dispatcher` owns the window listener plus the modifier and
 * editable-target guards (so typing a literal "/" into a field still works and
 * `Ctrl+/` never triggers it). We only `preventDefault` once there is an input
 * to focus, so a stray press without a mounted search box types through.
 */

import { type RefObject } from "react"

import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

export function useSearchHotkey(ref: RefObject<HTMLInputElement | null>): void {
  useAppShortcut("app.search.focus", (event) => {
    const input = ref.current
    if (!input) return
    event.preventDefault()
    input.focus()
  })
}
