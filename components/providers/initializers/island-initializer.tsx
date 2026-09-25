"use client"

/**
 * Main-window half of the task control island.
 *
 * The island window owns no Dexie and no app stores, so this initializer is
 * what gives it something to paint. It subscribes to the live sources the main
 * window already runs (the unified Fleet snapshot, the Control Center
 * attention aggregation, and the chat store and session rows behind the
 * conversations those mention), projects them into one read-only
 * `IslandState`, and pushes it over `island://state`.
 *
 * It is also the only place island intents are executed. The overlay may ask,
 * this window decides: every intent is re-validated against the current
 * projection and the current capabilities before anything runs, and the
 * decision itself goes through the owning surface's own path
 * (`lib/island/main-window-controls.ts`).
 *
 * Same shape as `UsageDockInitializer`, for the same reason. One window feeds
 * a least-privilege overlay, the overlay asks to be seeded when it mounts, and
 * ordering is settled by a monotonic revision rather than by luck.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"

import {
  getAttentionServerSnapshot,
  getAttentionSnapshot,
  subscribeAttention,
} from "@/lib/attention/attention-store"
import { getSessionsByIds } from "@/lib/db/sessions"
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
import { chatStatusOf, conversationCandidates, conversationFacts } from "@/lib/island/conversations"
import { detailFromAttention, detailFromSession } from "@/lib/island/detail"
import {
  decideGate,
  decideRunApproval,
  dismissStaleRow,
  replyToConversation,
  respondToChatApproval,
  stopConversation,
} from "@/lib/island/main-window-controls"
import { attentionOwner, fleetSessionOwner, taskIdentity } from "@/lib/island/owner"
import { projectIslandState, type IslandConversationFacts } from "@/lib/island/projection"
import { useIslandStore } from "@/lib/island/store"
import type { IslandActionIntent, IslandDetailRequest, IslandState } from "@/lib/island/types"
import { isTauri } from "@/lib/tauri"
import { selectExternalAgent } from "@/lib/agent/external-agent-selection"
import { useChatStore } from "@/stores/chat/chat-store"
import { useUIStore } from "@/stores/ui/ui-store"

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

  // The conversations the inputs mention. Keyed by one stable string, so the
  // row read below re-runs only when the SET changes, not on every snapshot.
  const candidatesKey = useMemo(
    () => conversationCandidates(fleet, attention).join("\n"),
    [fleet, attention]
  )
  // Their chat statuses as one stable string: the chat store updates on every
  // streamed token, and a fresh object per update would re-project per token.
  const statusesKey = useChatStore((store) =>
    candidatesKey
      ? candidatesKey
          .split("\n")
          .map((id) => store.sessions[id]?.status ?? "")
          .join("\n")
      : ""
  )
  const sessionRows = useLiveQuery(
    () => getSessionsByIds(candidatesKey ? candidatesKey.split("\n") : []),
    [candidatesKey]
  )
  // Keyed by VALUE: the row query re-emits on any write to a session row (an
  // `updatedAt` bump per streamed message), and a fresh object each time would
  // re-project and re-push the island for facts that did not change.
  const conversationsKey = useMemo(() => {
    const ids = candidatesKey ? candidatesKey.split("\n") : []
    const statuses = statusesKey.split("\n")
    return JSON.stringify(
      conversationFacts(
        Object.fromEntries(ids.map((id, index) => [id, chatStatusOf(statuses[index])])),
        sessionRows ?? []
      )
    )
  }, [candidatesKey, statusesKey, sessionRows])
  const conversations = useMemo(
    () => JSON.parse(conversationsKey) as Record<string, IslandConversationFacts>,
    [conversationsKey]
  )

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
        conversations,
        detailVisibility,
        epoch: epochRef.current,
        revision: revisionRef.current,
      })
    )
  }, [fleet, attention, conversations, detailVisibility, hydrated])

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

  const deps = useRef<IslandActionDeps | null>(null)
  useEffect(() => {
    deps.current = {
      navigate: (path, owner) => {
        if ((owner.kind === "chat" || owner.kind === "gate") && owner.sessionId) {
          useChatStore.getState().setActiveSession(owner.sessionId)
          useUIStore.getState().setSelectedGuild({ kind: "dm" })
        }
        if (owner.kind === "external") {
          // An ACP session bound to a chat opens that conversation; otherwise
          // the external-agents page shows the agent the row belongs to.
          if (owner.chatSessionId) {
            useChatStore.getState().setActiveSession(owner.chatSessionId)
            useUIStore.getState().setSelectedGuild({ kind: "dm" })
          }
          if (owner.agentId) selectExternalAgent(owner.agentId)
        }
        router.push(path)
      },
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
      dismissStale: dismissStaleRow,
      respondToChatApproval,
      decideGate,
      decideRunApproval,
      stopConversation,
      replyToConversation,
    }
  }, [router])

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

      // The same conversation lookup the projection used, or a conversation's
      // turn would not be found under the row id it was projected as.
      const session = fleet.sessions.find(
        (candidate) =>
          taskIdentity(fleetSessionOwner(candidate, (id) => id in conversations)) === row.id
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
    [attention, conversations, fleet]
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
      const liveDeps = deps.current
      if (!current || !liveDeps) {
        void sendIslandActionResult({
          requestId: intent.requestId,
          revision: 0,
          outcome: "rejected",
          reason: "staleRevision",
        })
        return
      }
      void executeIslandAction(intent, current, liveDeps)
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
