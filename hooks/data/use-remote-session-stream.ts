"use client"

/**
 * Remote Session Control — mobile viewer hook.
 *
 * Drives the phone's "remote session" detail view over a desktop-hosted
 * agent session. It:
 *
 *  1. **Attaches** as a live watcher (`session_attach`) so the host routes
 *     non-foreground `permission_request`s to this device instead of
 *     auto-denying — and **detaches** on unmount.
 *  2. **Streams** the session live by subscribing to `claude://message`
 *     (forwarded over `/ws/v1/events` by the host EventBus) and replaying it
 *     through the same `applySdkEvent` adapter the desktop chat hook uses, so
 *     assistant turns / tool calls render with the existing chat components.
 *     Seeded from the synced-down Dexie history for the initial paint.
 *  3. Exposes **control** actions — send a follow-up, interrupt, and resolve a
 *     pending tool-use approval — through the shared `lib/claude/ipc.ts`
 *     surface (`claude_send` / `claude_interrupt` / `claude_approve`), which
 *     routes to the host sidecar via the companion transport.
 *
 * Observe works for any paired device; the control RPCs require the
 * `allowRemoteControl` capability. If `session_attach` is rejected (403) the
 * hook still streams (read-only) and surfaces `canControl = false`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { applySdkEvent } from "@/lib/claude/adapter"
import { approveTool, interruptSession, sendPrompt } from "@/lib/claude/ipc"
import type {
  ApprovalDecision,
  ClaudeEvent,
  PendingApproval,
  SDKEventEnvelope,
} from "@/lib/claude/types"
import { listMessages } from "@/lib/db/messages"
import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"

const SIDECAR_EVENT = "claude://message"

export type RemoteStreamStatus = "loading" | "idle" | "streaming"

export interface RemoteSessionStream {
  /** Reconstructed conversation, source-of-truth for the chat renderer. */
  messages: UIMessage[]
  status: RemoteStreamStatus
  /** A tool-use approval awaiting this watcher's decision, if any. */
  pendingApproval: PendingApproval | null
  /** False when `session_attach` was rejected (device lacks the capability). */
  canControl: boolean
  /** Send a follow-up prompt into the host session. */
  send: (text: string) => Promise<void>
  /** Interrupt the in-flight turn. */
  interrupt: () => Promise<void>
  /** Resolve the pending approval (allow / allow_always / deny). */
  respond: (decision: ApprovalDecision) => Promise<void>
}

function isForSession(evt: ClaudeEvent, sessionId: string): boolean {
  return (evt as { sessionId?: string }).sessionId === sessionId
}

export function useRemoteSessionStream(sessionId: string | null): RemoteSessionStream {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [status, setStatus] = useState<RemoteStreamStatus>("loading")
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [canControl, setCanControl] = useState(true)
  // Keep the freshest message list for the long-lived stream handler without
  // resubscribing on every token. Seeded in the effect and maintained by the
  // stream handler — never written during render.
  const messagesRef = useRef<UIMessage[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    // Seed history from the synced-down Dexie store, then attach + stream.
    void (async () => {
      if (!sessionId) {
        setStatus("idle")
        return
      }
      const deviceId = loadCompanionConfig()?.deviceId ?? ""
      try {
        const history = await listMessages(sessionId)
        if (!cancelled) {
          messagesRef.current = history
          setMessages(history)
          setStatus("idle")
        }
      } catch {
        if (!cancelled) setStatus("idle")
      }

      // Attach as a live watcher. A 403 (no capability) downgrades to
      // observe-only; the stream subscription below still runs.
      try {
        await transport.call("session_attach", { sessionId, deviceId })
        if (!cancelled) setCanControl(true)
      } catch {
        if (!cancelled) setCanControl(false)
      }

      unsub = transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (evt) => {
        if (!isForSession(evt, sessionId)) return
        switch (evt.type) {
          case "event": {
            const env = evt as SDKEventEnvelope
            const { messages: next, turnComplete } = applySdkEvent(messagesRef.current, env.event)
            if (next !== messagesRef.current) {
              messagesRef.current = next
              setMessages(next)
            }
            setStatus(turnComplete ? "idle" : "streaming")
            return
          }
          case "permission_request": {
            setPendingApproval({
              sessionId: evt.sessionId,
              requestId: evt.requestId,
              toolUseID: evt.toolUseID,
              toolName: evt.toolName,
              input: evt.input,
              title: evt.title,
              displayName: evt.displayName,
              description: evt.description,
              blockedPath: evt.blockedPath,
              decisionReason: evt.decisionReason,
            })
            return
          }
          case "session_ended": {
            setStatus("idle")
            return
          }
          default:
            return
        }
      })
    })()

    return () => {
      cancelled = true
      unsub?.()
      if (!sessionId) return
      const did = loadCompanionConfig()?.deviceId ?? ""
      // Best-effort detach so the host stops routing approvals here.
      void transport.call("session_detach", { sessionId, deviceId: did }).catch(() => {})
    }
  }, [sessionId])

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return
      setStatus("streaming")
      await sendPrompt(sessionId, text)
    },
    [sessionId]
  )

  const interrupt = useCallback(async () => {
    if (!sessionId) return
    await interruptSession(sessionId)
    setStatus("idle")
  }, [sessionId])

  const respond = useCallback(
    async (decision: ApprovalDecision) => {
      const approval = pendingApproval
      if (!approval) return
      try {
        await approveTool(
          approval.sessionId,
          approval.requestId,
          decision === "allow_always" ? "allow" : decision
        )
      } finally {
        setPendingApproval(null)
      }
    },
    [pendingApproval]
  )

  return { messages, status, pendingApproval, canControl, send, interrupt, respond }
}
