"use client"

import { useEffect } from "react"

import { CODESERVER_EVENTS, type CodeServerEditorEvent } from "@/lib/codeserver/client"
import { notifyActiveEditorChanged } from "@/lib/files/project-editor-bridge"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * Which pushed events mean "what the user is looking at may have changed".
 *
 * `documentSaved` is deliberately included: a save changes the file's diagnostics
 * and its dirty state, both of which the active-editor snapshot reports.
 */
const ACTIVE_EDITOR_EVENTS: ReadonlySet<CodeServerEditorEvent["name"]> = new Set([
  "activeEditorChanged",
  "selectionChanged",
  "documentSaved",
  "diagnosticsChanged",
])

/**
 * Turns the companion extension's pushed editor events into the app's existing
 * "active editor changed" signal.
 *
 * Before this the agent channel was request-only, so anything that wanted to track
 * the user's focus in the Pro IDE had to poll `readActive` — which meant either a
 * timer burning IPC or, in practice, context that was silently stale. The extension
 * now reports changes as they happen and this hook republishes them through
 * {@link notifyActiveEditorChanged}, the seam Monaco already fires and every
 * consumer (the `read_active_editor` tool, the plugin editor API, the chat context
 * chip) already subscribes to.
 *
 * Deliberately payload-blind: subscribers re-read the authoritative snapshot through
 * the bridge, which is the only thing that knows which engine is live right now. The
 * event is a signal, not data.
 *
 * Scoped to `root` when given — a renderer can host two panes, and one project's
 * editor moving is not a reason to re-read the other's.
 */
export function useCodeServerEditorEvents(enabled: boolean, root?: string): void {
  useEffect(() => {
    if (!enabled || !isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (payload) => {
      if (cancelled) return
      if (root !== undefined && payload.root !== root) return
      if (!ACTIVE_EDITOR_EVENTS.has(payload.name)) return
      notifyActiveEditorChanged()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled, root])
}
