"use client"

// The single keydown listener for every `app`-scope shortcut. Mounted once,
// high in the tree (see `app-shortcut-dispatcher.tsx` in `app/layout.tsx`), it
// replaces the ~8 per-feature window listeners that used to hardcode their own
// chords + focus guards. One listener + first-match-wins ⇒ no double-fire; one
// shared editable guard ⇒ consistent "don't hijack typing" behavior.
//
// Resolution order per keystroke:
//   1. Build the normalized chord from the event (parseKeyEvent folds Ctrl/Cmd
//      and the `+`/`_` physical-key aliases).
//   2. Ask the runtime which registered handlers accept that chord (store-aware,
//      so a user override changes what matches).
//   3. For each hit in registration order: skip if it targets an editable
//      element it may not touch, skip if its `when` clause is false, else
//      preventDefault (if requested), run the handler, notify plugins, stop.

import { useEffect } from "react"

import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { evaluateContextWhen } from "@/lib/plugin/context-keys/context-key-store"
import { matchingAppShortcuts } from "@/lib/shortcuts/app-runtime"
import { isEditableTarget, isInsideEditorSurface } from "@/lib/shortcuts/dom"
import { normalizeKeyCombo, parseKeyEvent } from "@/lib/shortcuts/utils"
import { useAppKeybindingStore } from "@/stores/shortcuts/app-keybinding-store"

export function useAppShortcutDispatcher(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const chord = normalizeKeyCombo(parseKeyEvent(event))
      if (!chord) return

      const resolveAcceptedChords = (id: string) =>
        useAppKeybindingStore.getState().getAcceptedChords(id)
      const hits = matchingAppShortcuts(chord, resolveAcceptedChords)
      if (hits.length === 0) return

      for (const registration of hits) {
        // Never steal a chord from a declared code editor — it owns its keymap,
        // even for shortcuts that otherwise fire while a plain field is focused.
        if (
          registration.editorSelectors?.length &&
          isInsideEditorSurface(event.target, registration.editorSelectors)
        ) {
          continue
        }
        // Unless opted in, don't hijack a keystroke the user is typing into a field.
        if (!registration.allowInEditable && isEditableTarget(event.target)) continue
        if (registration.when && !evaluateContextWhen(registration.when)) continue

        if (registration.preventDefault) event.preventDefault()
        registration.handler(event)
        void getPluginEventHooks().dispatchShortcut(registration.commandId ?? registration.id)
        return
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
