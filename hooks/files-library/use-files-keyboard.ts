"use client"

/**
 * Wire the Files list's keyboard commands (`resolveFilesKey`) to the page
 * (ADR-0223). The handler goes on the list container, so the keys act only
 * while focus is inside the list — never while typing a search or a name.
 * Arrow keys move focus between items (`data-files-key`) and select the one
 * they land on; Shift extends from the anchor.
 */

import { useCallback, type KeyboardEvent } from "react"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { isEditableTarget, resolveFilesKey } from "@/lib/files-library/keyboard"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import type { FilesSelection } from "./use-files-selection"

/** The attribute every item card and row carries. */
export const FILES_ITEM_KEY_ATTR = "data-files-key"

function focusedKey(target: EventTarget | null): string | null {
  if (!target || typeof (target as Element).closest !== "function") return null
  return (
    (target as Element).closest(`[${FILES_ITEM_KEY_ATTR}]`)?.getAttribute(FILES_ITEM_KEY_ATTR) ??
    null
  )
}

export function useFilesKeyboard({
  entries,
  selection,
  trash,
  actions,
}: {
  entries: readonly FilesEntry[] | undefined
  selection: FilesSelection
  trash: boolean
  actions: Pick<FilesActions, "trash" | "preview">
}) {
  const { order, selected, anchorId, handleClick, selectAll, clear } = selection

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const store = useFilesLibraryStore.getState()
      const command = resolveFilesKey(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          editable: isEditableTarget(event.target),
        },
        {
          order,
          selected,
          current: focusedKey(event.target) ?? anchorId,
          previewOpen: store.selectedKey !== null,
        }
      )
      if (command.type === "none") return
      event.preventDefault()
      const byKey = (key: string) => entries?.find((entry) => entry.key === key)

      switch (command.type) {
        case "select-all":
          selectAll()
          break
        case "delete": {
          if (trash) store.openDeleteForever(command.keys)
          else {
            const chosen = command.keys.map(byKey).filter((entry) => entry !== undefined)
            void actions.trash(chosen)
            clear()
          }
          break
        }
        case "rename":
          if (!trash) store.openRename(command.key)
          break
        case "move": {
          handleClick(command.key, { ctrlKey: false, metaKey: false, shiftKey: command.extend })
          const entry = byKey(command.key)
          if (entry && !command.extend) actions.preview(entry)
          const container = event.currentTarget
          const node = container.querySelector<HTMLElement>(
            `[${FILES_ITEM_KEY_ATTR}="${CSS.escape(command.key)}"]`
          )
          node?.focus()
          node?.scrollIntoView?.({ block: "nearest" })
          break
        }
        case "clear-selection":
          clear()
          break
        case "close-preview":
          store.select(null)
          break
      }
    },
    [order, selected, anchorId, handleClick, selectAll, clear, entries, trash, actions]
  )
}
