"use client"

/**
 * Main-window half of the task control island.
 *
 * The island window owns no Dexie and no app stores, so this initializer is
 * what gives it something to paint. It subscribes to the two live sources the
 * main window already runs (the unified Fleet snapshot and the Control Center
 * attention aggregation), projects them into one read-only `IslandState`, and
 * pushes it over `island://state`.
 *
 * It is also the only place island intents are executed. The overlay may ask,
 * this window decides: every intent is re-validated against the current
 * projection and the current capabilities before a single Fleet command runs.
 *
 * Same shape as `UsageDockInitializer`, for the same reason. One window feeds
 * a least-privilege overlay, the overlay asks to be seeded when it mounts, and
 * ordering is settled by a monotonic revision rather than by luck.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"

import {
  getAttentionServerSnapshot,
  getAttentionSnapshot,
  subscribeAttention,
} from "@/lib/attention/attention-store"
import { unifiedFleetStore } from "@/lib/fleet/unified-fleet-store"
import { executeIslandAction, type IslandActionDeps } from "@/lib/island/actions"
import {
  onIslandActionIntent,
  onIslandDetailRequest,
  onIslandStateRequest,
  sendIslandActionResult,
  sendIslandDetailResponse,
  sendIslandState,
} from "@/lib/island/client"
import { detailFromAttention, detailFromSession } from "@/lib/island/detail"
import { attentionOwner, fleetSessionOwner, taskIdentity } from "@/lib/island/owner"
import { projectIslandState } from "@/lib/island/projection"
import { useIslandStore } from "@/lib/island/store"
import type {
  IslandActionIntent,
  IslandDetailRequest,
  IslandRowProjection,
  IslandState,
} from "@/lib/island/types"
import { isTauri } from "@/lib/tauri"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useChatStore } from "@/stores/chat/chat-store"

export function IslandInitializer() {
  const router = useRouter()
  const hydrate = useIslandStore((s) => s.hydrate)
  const hydrated = useIslandStore((s) => s.hydrated)
  const detailVisibility = useIslandStore((s) => s.preferences.detailVisibility)

  const fleet = useSyncExternalStore(
    unifiedFleetStore.subscribe,
    unifiedFleetStore.getSnapshot,
    unifiedFleetStore.getServerSnapshot
  )
  const attention = useSyncExternalStore(
    subscribeAttention,
    getAttentionSnapshot,
    getAttentionServerSnapshot
  )

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Monotonic per main-window session. A revision only ever rises, which is
  // what lets the overlay discard an out-of-order projection and this window
  // refuse an action built against one that no longer exists.
  const revisionRef = useRef(0)
  // One value per main-window session, so the overlay can tell a fresh
  // counter (after a main reload) from an out-of-order push. See IslandState.
  const epochRef = useRef(0)
  const [state, setState] = useState<IslandState | null>(null)

  useEffect(() => {
    if (!isTauri() || !hydrated) return
    if (epochRef.current === 0) epochRef.current = Date.now()
    revisionRef.current += 1
    setState(
      projectIslandState({
        fleet,
        attention,
        detailVisibility,
        epoch: epochRef.current,
        revision: revisionRef.current,
      })
    )
  }, [fleet, attention, detailVisibility, hydrated])

  // Push on every change. A closed island makes the emit resolve false, which
  // is the normal case rather than an error.
  useEffect(() => {
    if (state) void sendIslandState(state)
  }, [state])

  // The listeners must act on the CURRENT projection, not the one captured
  // when they were installed, so they read through a ref a commit-time effect
  // keeps fresh. Writing a ref during render is what React forbids.
  const latest = useRef<IslandState | null>(state)
  useEffect(() => {
    latest.current = state
  }, [state])

  /**
   * Clear a pending item whose waiter is gone.
   *
   * Only the three sources that own a clearing path are reachable here, and
   * the projection only sets `dismissStale` for those, so a refusal below is a
   * belt-and-braces check rather than the primary gate.
   */
  const dismissStale = useCallback(async (row: IslandRowProjection): Promise<boolean> => {
    if (row.owner.kind === "chat" && row.owner.requestId) {
      useChatStore.getState().clearApproval(row.owner.requestId, row.owner.sessionId)
      return true
    }
    if (row.owner.kind === "team") {
      const { teamId, runId } = row.owner
      const gate = usePendingGatesStore
        .getState()
        .gates.find(
          (candidate) =>
            (!teamId || candidate.teamId === teamId) && (!runId || candidate.runId === runId)
        )
      if (!gate) return false
      usePendingGatesStore.getState().close(gate.key)
      return true
    }
    if (row.owner.kind === "run" && row.owner.interruptId) {
      const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
      await expireRunInterruptFromSource(row.owner.runId, row.owner.interruptId)
      return true
    }
    return false
  }, [])

  const deps = useRef<IslandActionDeps>({
    navigate: () => {},
    dismissStale: async () => false,
  })
  useEffect(() => {
    deps.current = {
      navigate: (path: string) => router.push(path),
      async focusMainWindow() {
        if (!isTauri()) return
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window")
          const window = getCurrentWindow()
          await window.show()
          await window.setFocus()
        } catch {
          // Focusing is a courtesy. The navigation already happened.
        }
      },
      dismissStale,
    }
  }, [router, dismissStale])

  /**
   * Answer a detail request.
   *
   * Refused outright under `summary-only`, and refused when the row is gone or
   * the revision is ahead of ours. Nothing here is cached: the response is
   * built from the live source on each request, so an unpinned row leaves no
   * copy behind on either side of the bridge.
   */
  const answerDetail = useCallback(
    (request: IslandDetailRequest) => {
      const current = latest.current
      const revision = current?.revision ?? 0
      const refuse = (reason: string) =>
        void sendIslandDetailResponse({
          requestId: request.requestId,
          revision,
          rowId: request.rowId,
          detail: null,
          reason,
        })

      if (!current) return refuse("unavailable")
      if (current.detailVisibility === "summary-only") return refuse("notPermitted")
      if (request.revision > revision) return refuse("staleRevision")
      const row = current.rows.find((candidate) => candidate.id === request.rowId)
      if (!row || !row.capabilities.detail) return refuse("unknownRow")

      const session = fleet.sessions.find(
        (candidate) => taskIdentity(fleetSessionOwner(candidate)) === row.id
      )
      if (session) {
        void sendIslandDetailResponse({
          requestId: request.requestId,
          revision,
          rowId: row.id,
          detail: detailFromSession(session),
        })
        return
      }
      // Identity, never title: a redacted, truncated title is not evidence
      // that two observations are the same task.
      const item = attention.find((candidate) => {
        const owner = attentionOwner(candidate)
        return owner ? taskIdentity(owner) === row.id : false
      })
      if (!item) return refuse("unavailable")
      void sendIslandDetailResponse({
        requestId: request.requestId,
        revision,
        rowId: row.id,
        detail: detailFromAttention(item),
      })
    },
    [attention, fleet]
  )

  const answerDetailRef = useRef(answerDetail)
  useEffect(() => {
    answerDetailRef.current = answerDetail
  }, [answerDetail])

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    const offs: Array<() => void> = []
    const track = (off: () => void) => (alive ? offs.push(off) : off())

    void onIslandStateRequest(() => {
      if (alive && latest.current) void sendIslandState(latest.current)
    }).then(track)

    void onIslandActionIntent((intent: IslandActionIntent) => {
      if (!alive) return
      const current = latest.current
      if (!current) {
        void sendIslandActionResult({
          requestId: intent.requestId,
          revision: 0,
          outcome: "rejected",
          reason: "staleRevision",
        })
        return
      }
      void executeIslandAction(intent, current, deps.current)
        .then((result) => sendIslandActionResult(result))
        .catch(() =>
          sendIslandActionResult({
            requestId: intent.requestId,
            revision: current.revision,
            outcome: "failed",
            reason: "callFailed",
          })
        )
    }).then(track)

    void onIslandDetailRequest((request) => {
      if (alive) answerDetailRef.current(request)
    }).then(track)

    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])

  return null
}

export default IslandInitializer
