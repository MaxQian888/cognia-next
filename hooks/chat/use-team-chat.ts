"use client"

/**
 * Team rooms, for the shells that have a React tree.
 *
 * This hook used to *be* the orchestration: routing, transcript building,
 * round planning, supervisor dispatch, streaming, all in 1800 lines of
 * closures. That is now `lib/chat/room/runner.ts` (ADR-0177), and this file
 * is the adapter that hands it store-backed sinks and the sidecar events.
 *
 * Two shapes, chosen once per mount:
 *
 * - **Host** (desktop renderer). The turn runs here, on the process-wide
 *   runner from `runner-host.ts`, which the `room_send` RPC arm shares so a
 *   phone's turn and a local turn on one room never race.
 * - **Companion** (Capacitor, web companion). The turn runs on the paired
 *   host. `send` becomes a `room_send` call, `stop` a `room_stop`, and the
 *   hook only projects the member sub-session events it already receives on
 *   the mirrored channel into the store, so streaming text still renders.
 *   Durable rows arrive through the sync mirror. Before this the phone ran
 *   the whole loop itself and lost the round when it went to sleep.
 *
 * Mount this hook once at the shell level alongside `useClaudeChat`. The two
 * partition the event stream with `decodeSubSession` so they never both
 * react to the same event.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import type { UnlistenFn } from "@tauri-apps/api/event"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { onClaudeMessage } from "@/lib/claude/ipc"
import { makeUserMessage } from "@/lib/claude/adapter"
import type {
  ApprovalDecision,
  PendingApproval,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import {
  getCompanionRoomProjector,
  getHostRoomRunner,
  type CompanionRoomProjector,
} from "@/lib/chat/room/runner-host"
import type { RoomRunner } from "@/lib/chat/room/runner"
import { withMetadata } from "@/lib/chat/room/runner"
import { sendRoomTurn, stopRoomTurn } from "@/lib/companion/room-send-client"
import { maybeDrainSteer, steerArmed } from "./steer-runtime"
import { useChatStore } from "@/stores/chat"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

/** Options for a team send. `sessionId` targets a background pane (defaults
 * to the active session). See `RoomSendOptions` for the rest. */
export interface TeamSendOptions {
  attachmentManifest?: readonly AttachmentManifestEntry[]
  sessionId?: string
  skipPersistUserTurn?: boolean
  steerDrain?: boolean
  branchTag?: { groupId: string; index: number }
  webSearchContext?: SendOptions["webSearchContext"]
}

type TeamSendFn = (content: SendContent, opts?: TeamSendOptions) => Promise<void>

/** A companion shell has a paired host that orchestrates for it. */
function isCompanionShell(): boolean {
  return !isTauri() && (isCapacitor() || hasWebCompanionTarget())
}

export function useTeamChat() {
  const tInlineErr = useTranslations("chat.inlineError")
  const companion = isCompanionShell()
  const engine = useMemo<{ runner: RoomRunner; projector: CompanionRoomProjector | null }>(
    () =>
      companion
        ? { runner: getCompanionRoomProjector().runner, projector: getCompanionRoomProjector() }
        : { runner: getHostRoomRunner(), projector: null },
    [companion]
  )

  // Subscribe to sidecar events. Same sources as direct chat: Tauri events on
  // desktop, the mirrored companion WebSocket on Capacitor / web-companion.
  // Plain web has none.
  useEffect(() => {
    if (!isTauri() && !isCapacitor() && !hasWebCompanionTarget()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false
    const { runner, projector } = engine

    onClaudeMessage((evt) => (projector ? projector.handleEvent(evt) : runner.handleEvent(evt)))
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch((err) => {
        console.error("listen team events failed", err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [engine])

  const sendRef = useRef<TeamSendFn | null>(null)

  /**
   * Companion send: show the message straight away, hand the turn to the
   * host. The host persists the row and the sync mirror brings it back, so
   * this append is store-only on purpose.
   */
  const sendViaHost = useCallback(
    async (sessionId: string, content: SendContent, opts?: TeamSendOptions) => {
      const projector = engine.projector
      if (!projector) return
      if (!opts?.skipPersistUserTurn && !opts?.steerDrain) {
        const optimistic = withMetadata(
          makeUserMessage(content, undefined, opts?.attachmentManifest),
          { senderKind: "user" }
        )
        const before = useChatStore.getState().sessions[sessionId]?.messages ?? []
        useChatStore.getState().replaceSessionMessages(sessionId, [...before, optimistic])
      }
      projector.markSending(sessionId)
      try {
        const result = await sendRoomTurn({
          sessionId,
          content,
          webSearchContext: opts?.webSearchContext,
          attachmentManifest: opts?.attachmentManifest,
        })
        if (!result.accepted) throw new Error("room_send was not accepted")
      } catch (err) {
        useChatStore.getState().setSessionStatus(sessionId, "idle")
        useChatStore
          .getState()
          .setSessionDiagnostic(
            sessionId,
            toDiagnostic(err, { source: "agent-team", meta: { sessionId } })
          )
      }
    },
    [engine]
  )

  /**
   * Send a user prompt to a team session (the active one by default, or
   * `opts.sessionId` for a background pane). Returns once every member has
   * either replied or errored on a host, or once the host accepted the turn
   * on a companion.
   */
  const send = useCallback<TeamSendFn>(
    async (content, opts) => {
      const sessionId = opts?.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) {
        useChatStore.getState().setError(tInlineErr("noSession"))
        return
      }
      if (engine.projector) {
        await sendViaHost(sessionId, content, opts)
        return
      }
      await engine.runner.send(content, { ...opts, sessionId })
    },
    [engine, sendViaHost, tInlineErr]
  )

  useEffect(() => {
    sendRef.current = send
    return () => {
      if (sendRef.current === send) sendRef.current = null
    }
  }, [send])

  const drainSteerInto = useCallback((sessionId: string) => {
    maybeDrainSteer(
      sessionId,
      (payload, webSearchContext) =>
        void sendRef.current?.(payload, { sessionId, steerDrain: true, webSearchContext })
    )
  }, [])

  /** Cancel an in-flight team turn (the active session's by default). */
  const stop = useCallback(
    async (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (engine.projector) {
        useChatStore.getState().clearSteerQueue(sessionId)
        steerArmed.delete(sessionId)
        useChatStore.getState().setSessionStatus(sessionId, "idle")
        await stopRoomTurn(sessionId).catch((err) => console.error("room_stop failed", err))
        return
      }
      await engine.runner.stop(sessionId)
    },
    [engine]
  )

  /** Cut the running turn short so its settle replays the queued steer. */
  const interruptAndSteer = useCallback(
    async (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (engine.projector) {
        const queued = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
        if (queued.length === 0) return
        await stopRoomTurn(sessionId).catch((err) => console.error("room_stop failed", err))
        drainSteerInto(sessionId)
        return
      }
      await engine.runner.interruptAndSteer(sessionId)
    },
    [engine, drainSteerInto]
  )

  /** Replay a session's queued steer NOW, without a turn boundary. */
  const flushSteer = useCallback(
    (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (engine.projector) {
        drainSteerInto(sessionId)
        return
      }
      engine.runner.flushSteer(sessionId)
    },
    [engine, drainSteerInto]
  )

  /** Re-issue the most recent user turn, keeping the old replies as branches. */
  const regenerate = useCallback(
    async (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (engine.projector) {
        engine.projector.markSending(sessionId)
        await sendRoomTurn({ sessionId, regenerate: true }).catch((err) =>
          console.error("room_send regenerate failed", err)
        )
        return
      }
      await engine.runner.regenerate(sessionId)
    },
    [engine]
  )

  /** Edit a sent user message without destroying the team turn below it. */
  const editAndResend = useCallback(
    async (messageId: string, newContent: SendContent, targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (engine.projector) {
        engine.projector.markSending(sessionId)
        await sendRoomTurn({ sessionId, content: newContent, editMessageId: messageId }).catch(
          (err) => console.error("room_send edit failed", err)
        )
        return
      }
      await engine.runner.editAndResend(sessionId, messageId, newContent)
    },
    [engine]
  )

  /** Approve or deny a tool call. Routes to the member sub-session. */
  const respondToApproval = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision) => {
      await engine.runner.respondToApproval(approval, decision)
    },
    [engine]
  )

  return { send, stop, regenerate, editAndResend, respondToApproval, interruptAndSteer, flushSteer }
}
