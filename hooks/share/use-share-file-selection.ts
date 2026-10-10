"use client"

/**
 * A conversation's FileSpace and what a share would carry from it (ADR-0222).
 *
 * The FileSpace is live (`useConversationFileSpace`); the selection — FileSpace
 * paths the person ticked — is expanded into concrete files whenever either
 * changes, walking folders on the host. An expansion that was overtaken by a
 * newer selection is dropped rather than shown, so a slow walk can never
 * replace the answer to the current selection with the answer to an old one.
 */

import { useEffect, useState } from "react"

import { useConversationFileSpace } from "@/hooks/filespace/use-conversation-filespace"
import type { LoadedConversationFileSpace } from "@/lib/filespace/load"
import { expandShareSelection, type ExpandedShareSelection } from "@/lib/share/file-selection"
import type { FileSpacePath } from "@/types/filespace"

export interface ShareFileSelection {
  /** `undefined` while loading, `null` when the conversation is gone. */
  loaded: LoadedConversationFileSpace | null | undefined
  /** The expansion of the current selection; `null` until one has completed. */
  expanded: ExpandedShareSelection | null
  /** The current selection has not been expanded yet. */
  pending: boolean
  /** Expanding the current selection failed. */
  failed: boolean
}

interface Result {
  key: string
  expanded: ExpandedShareSelection | null
  failed: boolean
}

const EMPTY: ExpandedShareSelection = {
  files: [],
  skippedSensitive: 0,
  truncated: false,
  issues: [],
}

export function useShareFileSelection(
  sessionId: string | null,
  selected: readonly FileSpacePath[],
  expand: typeof expandShareSelection = expandShareSelection
): ShareFileSelection {
  const loaded = useConversationFileSpace(sessionId)
  const [result, setResult] = useState<Result | null>(null)
  const key = selected.join("\n")
  const space = loaded?.space

  useEffect(() => {
    if (!space || key === "") return
    let current = true
    expand(space, key.split("\n") as FileSpacePath[]).then(
      (expanded) => {
        if (current) setResult({ key, expanded, failed: false })
      },
      () => {
        if (current) setResult({ key, expanded: null, failed: true })
      }
    )
    return () => {
      current = false
    }
  }, [space, key, expand])

  if (key === "") return { loaded, expanded: EMPTY, pending: false, failed: false }
  const fresh = result?.key === key ? result : null
  return {
    loaded,
    expanded: fresh?.expanded ?? null,
    pending: !fresh,
    failed: fresh?.failed ?? false,
  }
}
