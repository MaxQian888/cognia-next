"use client"

/**
 * Tap-to-connect — the mobile alternative to React Flow's drag-from-handle
 * edge creation, which is too fiddly on touch (small targets, finger
 * occlusion). Two entry points feed the same machine:
 *   • tapping a node's source handle (the discoverable path — see the shared
 *     node renderer's `armConnectFromHandle`, gated on the store's
 *     `touchConnect`), which roots the connection at that specific handle so
 *     branch/switch outputs route correctly; and
 *   • the inspector's "Connect" action (the fallback path), which roots at the
 *     node's primary output.
 * The user then taps a target node to create the edge.
 *
 * This is a thin state machine over the editor store's existing connection
 * machinery — it does NOT reimplement edge creation:
 *   • `beginConnection({ sourceId, sourceHandle })` sets `connectionState`,
 *     which the node renderers already read to ring compatible handles (same
 *     visual feedback as a desktop drag).
 *   • `connect({ source, target, sourceHandle })` is the store's undoable edge
 *     mutation.
 *   • `validateConnection` is the same gate the desktop canvas uses.
 *
 * `connectionState` IS the source of truth — the hook derives `active`/`sourceId`
 * from it (no duplicate local state) so a handle tap and a Connect-button tap are
 * indistinguishable downstream.
 */

import { useCallback } from "react"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"

export interface TapConnect {
  /** The node we're drawing an edge from, or null when not in connect mode. */
  sourceId: string | null
  /** True while waiting for the user to tap a target. */
  active: boolean
  /**
   * Enter connect mode rooted at `sourceId`. `sourceHandle` selects which
   * output the edge attaches to (branch/switch); defaults to the primary
   * output (`null`).
   */
  start: (sourceId: string, sourceHandle?: string | null) => void
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
  // Subscribe to the store's connection state so handle-tap-initiated
  // connections (which set it directly) re-render the editor chrome too.
  const connectionState = store((s) => s.connectionState)
  const sourceId = connectionState?.sourceId ?? null

  const start = useCallback(
    (id: string, sourceHandle: string | null = null) => {
      store.getState().beginConnection({ sourceId: id, sourceHandle })
    },
    [store]
  )

  const cancel = useCallback(() => {
    store.getState().endConnection()
  }, [store])

  const completeTo = useCallback(
    (targetId: string): ReturnType<typeof validateConnection> => {
      const state = store.getState()
      const cs = state.connectionState
      if (!cs)
        return { valid: false, reason: "Not in connect mode.", reasonKey: "notConnecting" }
      const connection = {
        source: cs.sourceId,
        target: targetId,
        sourceHandle: cs.sourceHandle ?? undefined,
      }
      const result = validateConnection(
        connection,
        state.nodes,
        state.edges,
        { errorPolicy: state.baseWorkflow.settings.errorPolicy }
      )
      if (result.valid) {
        state.connect(connection)
      }
      // Leave connect mode regardless — an invalid tap exits so the user
      // isn't trapped; they re-enter from a handle / the inspector if they
      // meant to.
      state.endConnection()
      return result
    },
    [store]
  )

  return { sourceId, active: sourceId !== null, start, completeTo, cancel }
}
