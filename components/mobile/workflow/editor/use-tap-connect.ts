"use client"

/**
 * Tap-to-connect — the mobile alternative to React Flow's drag-from-handle
 * edge creation, which is too fiddly on touch (small targets, finger
 * occlusion). The user taps a selected node's "Connect" action to enter
 * connect mode, then taps a target node to create the edge.
 *
 * This is a thin state machine over the editor store's existing connection
 * machinery — it does NOT reimplement edge creation:
 *   • `beginConnection({ sourceId })` sets `connectionState`, which the node
 *     renderers already read to ring compatible handles (same visual feedback
 *     as a desktop drag).
 *   • `connect({ source, target })` is the store's undoable edge mutation.
 *   • `validateConnection` is the same gate the desktop canvas uses.
 *
 * The only new state is `sourceId` (which node we're connecting from).
 */

import { useCallback, useState } from "react"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"

export interface TapConnect {
  /** The node we're drawing an edge from, or null when not in connect mode. */
  sourceId: string | null
  /** True while waiting for the user to tap a target. */
  active: boolean
  /** Enter connect mode rooted at `sourceId` (highlights compatible targets). */
  start: (sourceId: string) => void
  /**
   * Attempt to connect the active source to `targetId`. Returns the
   * validation result so the caller can surface the rejection reason. A
   * no-op (returns `{ valid: false }`) when not in connect mode.
   */
  completeTo: (targetId: string) => ReturnType<typeof validateConnection>
  /** Leave connect mode without creating an edge. */
  cancel: () => void
}

export function useTapConnect(store: EditorStore): TapConnect {
  const [sourceId, setSourceId] = useState<string | null>(null)

  const start = useCallback(
    (id: string) => {
      store.getState().beginConnection({ sourceId: id, sourceHandle: null })
      setSourceId(id)
    },
    [store]
  )

  const cancel = useCallback(() => {
    store.getState().endConnection()
    setSourceId(null)
  }, [store])

  const completeTo = useCallback(
    (targetId: string): ReturnType<typeof validateConnection> => {
      if (!sourceId)
        return { valid: false, reason: "Not in connect mode.", reasonKey: "notConnecting" }
      const state = store.getState()
      const result = validateConnection(
        { source: sourceId, target: targetId },
        state.nodes,
        state.edges
      )
      if (result.valid) {
        state.connect({ source: sourceId, target: targetId })
      }
      // Leave connect mode regardless — an invalid tap exits so the user
      // isn't trapped; they re-enter from the inspector if they meant to.
      state.endConnection()
      setSourceId(null)
      return result
    },
    [sourceId, store]
  )

  return { sourceId, active: sourceId !== null, start, completeTo, cancel }
}
