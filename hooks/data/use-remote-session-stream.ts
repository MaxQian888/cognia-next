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
 *     (forwarded over `/ws/events` by the host EventBus) and replaying it
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
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { applySdkEvent } from "@/lib/claude/adapter"
import { approveTool, interruptSession, sendPrompt } from "@/lib/claude/ipc"
import type {
  ApprovalDecision,
  ClaudeEvent,
  PendingApproval,
  SDKEventEnvelope,
} from "@cognia/agent-config-types"
import { listMessages } from "@/lib/db/messages"
import { runSyncDown } from "@/lib/sync/companion-sync"
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
  /**
   * True once the host session has terminated (`session_ended`) or the host
   * sidecar exited — the composer/interrupt controls lock out and the view
   * shows an "ended" notice instead of looking deceptively live.
   */
  sessionEnded: boolean
  /**
   * True when `session_attach` failed because the session no longer exists on
   * the desktop (404). Distinct from a permission denial (which downgrades to
   * observe-only with `canControl=false` but a still-valid session).
   */
  notFound: boolean
  /** Send a follow-up prompt into the host session. */
  send: (text: string) => Promise<void>
  /** Interrupt the in-flight turn. */
  interrupt: () => Promise<void>
  /** Resolve the pending approval (allow / allow_always / deny). */
  respond: (decision: ApprovalDecision) => Promise<void>
  /**
   * Release a completed live turn after the transcript controller has adopted
   * the host revision that contains it. Active turns are never discarded.
   */
  reconcileTranscript: () => void
}

export interface RemoteSessionStreamOptions {
  /** Legacy-only: seed the full mirrored history before applying live deltas. */
  seedHistory?: boolean
}

function isForSession(evt: ClaudeEvent, sessionId: string): boolean {
  return (evt as { sessionId?: string }).sessionId === sessionId
}

function frameType(evt: unknown): string | undefined {
  return (evt as { type?: string } | null)?.type
}

function errReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A control RPC was rejected because this device lacks (or just lost) the
 * `allowRemoteControl` capability. Matches the structured `CompanionError.code`
 * the host returns and falls back to message text for generic errors.
 */
function isControlForbidden(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === "remote_control_forbidden" || code === "http_403") return true
  const msg = errReason(err)
  return /\b403\b/.test(msg) || /forbidden/i.test(msg)
}

/** The attached session no longer exists on the desktop. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === "http_404" || code === "session_not_found") return true
  const msg = errReason(err)
  return /\b404\b/.test(msg) || /not[_\s-]?found/i.test(msg)
}

export function useRemoteSessionStream(
  sessionId: string | null,
  options: RemoteSessionStreamOptions = {}
): RemoteSessionStream {
  const seedHistory = options.seedHistory ?? true
  const t = useTranslations("mobile.remoteSessions")
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [status, setStatus] = useState<RemoteStreamStatus>("loading")
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [canControl, setCanControl] = useState(true)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [notFound, setNotFound] = useState(false)
  // Keep the freshest message list for the long-lived stream handler without
  // resubscribing on every token. Seeded in the effect and maintained by the
  // stream handler — never written during render.
  const messagesRef = useRef<UIMessage[]>([])
  const liveTurnCompleteRef = useRef(false)
  // Mirror of `status` for the control callbacks: their closures must read the
  // live value (e.g. the interrupt guard) without being recreated per token.
  const statusRef = useRef<RemoteStreamStatus>("loading")
  const setStatusBoth = useCallback((next: RemoteStreamStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    let messageCommitFrame: number | null = null
    let streamedRevision = 0

    const scheduleMessageCommit = () => {
      if (messageCommitFrame !== null) return
      messageCommitFrame = requestAnimationFrame(() => {
        messageCommitFrame = null
        if (!cancelled) setMessages(messagesRef.current)
      })
    }

    // Re-seed the scrollback from Dexie. Used both for the initial paint and
    // after a transport `resync_required` (a cursor gap can leave the streamed
    // list permanently stale). Only adopt the Dexie snapshot when it is at
    // least as complete as the in-memory stream so we never clobber freshly
    // streamed deltas that the sync orchestrator hasn't persisted yet.
    const reseedFromDexie = async () => {
      if (!sessionId || !seedHistory) return
      const revisionAtStart = streamedRevision
      try {
        // A resync frame means the local mirror is not authoritative until the
        // bounded sync-down completes. Afterwards, accept deletions and
        // same-length corrections as well as append-only snapshots.
        await runSyncDown({ only: ["messages"] })
        const history = await listMessages(sessionId)
        if (cancelled || streamedRevision !== revisionAtStart) return
        messagesRef.current = history
        scheduleMessageCommit()
      } catch {
        // best-effort — keep whatever we already have
      }
    }

    // Seed history from the synced-down Dexie store, then attach + stream.
    void (async () => {
      if (!sessionId) {
        setStatusBoth("idle")
        return
      }
      const deviceId = loadCompanionConfig()?.deviceId ?? ""
      if (seedHistory) {
        try {
          const history = await listMessages(sessionId)
          if (!cancelled) {
            messagesRef.current = history
            setMessages(history)
            setStatusBoth("idle")
          }
        } catch {
          if (!cancelled) setStatusBoth("idle")
        }
        // Background freshness is legacy-only. Transcript-capable clients
        // reconcile the bounded newest timeline page instead of draining the
        // sync table into Dexie.
        void runSyncDown({ only: ["messages"] }).catch(() => {})
      } else if (!cancelled) {
        messagesRef.current = []
        liveTurnCompleteRef.current = false
        setMessages([])
        setStatusBoth("idle")
      }

      // Attach as a live watcher. Branch on the failure: a permission denial
      // (403) downgrades to observe-only with a still-valid session; a 404
      // means the session is gone; a network error is left optimistic and the
      // transport reconnect (surfaced by the detail view's connection UI)
      // recovers it rather than falsely flagging observe-only.
      try {
        await transport.call("session_attach", { sessionId, deviceId })
        if (!cancelled) setCanControl(true)
      } catch (err) {
        if (cancelled) return
        if (isNotFound(err)) {
          setNotFound(true)
          setCanControl(false)
        } else if (isControlForbidden(err)) {
          setCanControl(false)
        }
        // else: retryable/network — stay optimistic, let transport reconnect.
      }

      unsub = transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (evt) => {
        // `resync_required` is a synthetic, non-session-scoped frame the
        // transport dispatches after a cursor gap — handle it BEFORE the
        // session filter (it carries no `sessionId`).
        if (frameType(evt) === "resync_required") {
          void reseedFromDexie()
          return
        }
        // `sidecar_exited` is also non-session-scoped but terminal for every
        // host session — treat it as an end for the one we're watching.
        if (frameType(evt) === "sidecar_exited") {
          setSessionEnded(true)
          setStatusBoth("idle")
          setPendingApproval(null)
          return
        }
        if (!isForSession(evt, sessionId)) return
        switch (evt.type) {
          case "event": {
            const env = evt as SDKEventEnvelope
            const { messages: next, turnComplete } = applySdkEvent(messagesRef.current, env.event)
            if (next !== messagesRef.current) {
              messagesRef.current = next
              streamedRevision += 1
              scheduleMessageCommit()
            }
            liveTurnCompleteRef.current = turnComplete
            setStatusBoth(turnComplete ? "idle" : "streaming")
            // The host blocks the turn on a pending approval; a fresh event
            // means it advanced, so the host already resolved the approval
            // (typically via its 120s backstop). Clear our stale card.
            setPendingApproval((cur) => (cur ? null : cur))
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
            setSessionEnded(true)
            setStatusBoth("idle")
            setPendingApproval(null)
            return
          }
          default:
            return
        }
      })
    })()

    return () => {
      cancelled = true
      if (messageCommitFrame !== null) cancelAnimationFrame(messageCommitFrame)
      unsub?.()
      if (!sessionId) return
      const did = loadCompanionConfig()?.deviceId ?? ""
      // Best-effort detach so the host stops routing approvals here.
      void transport.call("session_detach", { sessionId, deviceId: did }).catch(() => {})
    }
  }, [seedHistory, sessionId, setStatusBoth])

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return
      // Optimistic streaming state for immediate feedback; reverted on failure
      // so a rejected/offline send never leaves the composer stuck showing the
      // interrupt control over nothing in flight.
      setStatusBoth("streaming")
      try {
        await sendPrompt(sessionId, text)
      } catch (err) {
        setStatusBoth("idle")
        if (isControlForbidden(err)) {
          setCanControl(false)
          toast.warning(t("detail.controlLost"))
        } else {
          toast.error(t("detail.sendFailed", { reason: errReason(err) }))
        }
      }
    },
    [sessionId, setStatusBoth, t]
  )

  const interrupt = useCallback(async () => {
    if (!sessionId) return
    // Nothing in flight — don't fire a spurious interrupt RPC.
    if (statusRef.current !== "streaming") return
    try {
      await interruptSession(sessionId)
      setStatusBoth("idle")
    } catch (err) {
      if (isControlForbidden(err)) {
        setCanControl(false)
        toast.warning(t("detail.controlLost"))
      } else {
        toast.error(t("detail.interruptFailed", { reason: errReason(err) }))
      }
    }
  }, [sessionId, setStatusBoth, t])

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
        setPendingApproval(null)
      } catch (err) {
        if (isControlForbidden(err)) {
          setCanControl(false)
          setPendingApproval(null)
          toast.warning(t("detail.controlLost"))
        } else {
          // Keep the card mounted so the user can retry the decision.
          toast.error(t("approval.respondFailed", { reason: errReason(err) }))
        }
      }
    },
    [pendingApproval, t]
  )

  const reconcileTranscript = useCallback(() => {
    if (seedHistory || !liveTurnCompleteRef.current) return
    liveTurnCompleteRef.current = false
    messagesRef.current = []
    setMessages([])
  }, [seedHistory])

  return {
    messages,
    status,
    pendingApproval,
    canControl,
    sessionEnded,
    notFound,
    send,
    interrupt,
    respond,
    reconcileTranscript,
  }
}
