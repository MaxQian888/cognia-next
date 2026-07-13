"use client"

// Feature-facing hook for `app`-scope shortcuts. A component calls this once
// per action; it registers a live handler into the app-shortcut runtime while
// mounted and removes it on unmount, so the single `use-app-shortcut-dispatcher`
// can drive it. The handler is held in a ref, so the registration is stable
// across re-renders and never churns the runtime.
//
// Mount-scoping is the activation guard: the shortcut only exists while the
// component is mounted. The optional `when` clause (defaulting to the catalog
// descriptor's) adds route/platform gating on top for always-mounted callers.

import { useEffect, useRef } from "react"

import { registerAppShortcut, type AppShortcutRegistration } from "@/lib/shortcuts/app-runtime"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"

export interface UseAppShortcutOptions {
  /** When false, the shortcut is not registered at all (no runtime slot). Defaults to true. */
  enabled?: boolean
  /** Override the catalog descriptor's `when` clause gating activation. */
  when?: string
  /** Fire even while an editable control is focused. Defaults to false. */
  allowInEditable?: boolean
  /** Call `event.preventDefault()` before the handler runs. */
  preventDefault?: boolean
  /** Editor surfaces whose descendants also count as editable (e.g. `[".monaco-editor"]`). */
  editorSelectors?: string[]
  /** Plugin/command dispatch id; defaults to the descriptor's `commandId` then the shortcut id. */
  commandId?: string
}

export function useAppShortcut(
  id: string,
  handler: (event: KeyboardEvent) => void,
  options: UseAppShortcutOptions = {}
): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  const {
    enabled = true,
    when,
    allowInEditable,
    preventDefault,
    editorSelectors,
    commandId,
  } = options
  // Stable primitive so the registration effect only re-runs when the selector
  // *contents* change, not on every new array identity.
  const editorSelectorsKey = editorSelectors?.join(",") ?? ""

  useEffect(() => {
    if (!enabled) return
    const descriptor = getAppShortcutDescriptor(id)
    const registration: AppShortcutRegistration = {
      id,
      handler: (event) => handlerRef.current(event),
      when: when ?? descriptor?.when,
      allowInEditable,
      preventDefault,
      editorSelectors: editorSelectorsKey ? editorSelectorsKey.split(",") : undefined,
      commandId: commandId ?? descriptor?.commandId,
    }
    return registerAppShortcut(registration)
  }, [id, enabled, when, allowInEditable, preventDefault, editorSelectorsKey, commandId])
}
