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
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import {
  uploadSessionAttachment,
  type AttachmentUploadProgress,
  type UploadableAttachment,
  type UploadedAttachment,
} from "@/lib/companion/attachment-upload-client"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { transport } from "@/lib/tauri"
import { ATTACH_LEASE_RENEW_INTERVAL_MS } from "@/lib/companion/device-presence-registry"
import type { AttachDowngradeReason } from "@/lib/companion/remote-attach-registry"

const SIDECAR_EVENT = "claude://message"

/** What the Host answers to `session_attach`. Every field is optional: a Host
 *  from before lease-backed attach answers `null`. */
interface AttachResponse {
  mode?: string
  downgradeReason?: AttachDowngradeReason | null
  eventPlane?: string
  leaseTtlMs?: number
  renewIntervalMs?: number
}

/**
 * Whether the user is looking at this device right now. Reported on attach and
 * on every renewal so the Host can suppress a push for a prompt already on
 * screen. `unknown` outside a browser document — it suppresses nothing.
 */
function documentAttention(): "foreground" | "background" | "unknown" {
  if (typeof document === "undefined") return "unknown"
  return document.visibilityState === "visible" ? "foreground" : "background"
}

export type RemoteStreamStatus = "loading" | "idle" | "streaming"

export interface RemoteSendOptions {
  /**
   * Per-file upload progress, keyed by the index in the `attachments` array
   * the caller passed.
   *
   * A phone on a cellular link spends most of a send waiting for bytes to
   * cross, and a composer that shows nothing during it reads as hung. The
   * index rather than an id because the caller already knows the order it
   * handed over, and inventing an id here would be a second identity for
   * something that already has one on the caller's side.
   */
  onUploadProgress?: (index: number, progress: AttachmentUploadProgress) => void
}

export interface RemoteSessionStream {
  /** Reconstructed conversation, source-of-truth for the chat renderer. */
  messages: UIMessage[]
  status: RemoteStreamStatus
  /** A tool-use approval awaiting this watcher's decision, if any. */
  pendingApproval: PendingApproval | null
  /** False when this device was attached as an observer rather than a
   *  controller — it lacks the capability, or its event stream is not caught
   *  up. `attachDowngrade` says which. */
  canControl: boolean
  /**
   * Why control was refused, as the Host reported it, or null when the device
   * is controlling (or never asked). The two cases need different UI: a missing
   * grant is permanent until someone toggles it on the desktop, while an
   * event-plane that is not ready clears itself on reconnect.
   */
  attachDowngrade: AttachDowngradeReason | null
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
  /**
   * Send a follow-up prompt into the host session.
   *
   * Attachments are uploaded to the Host first and the message carries only the
   * refs that come back — the bytes never enter the action ledger, the replay
   * stream, or a queue row that might be retried. Rejects if any part fails, so
   * the composer keeps the text and the files instead of clearing them for a
   * send that did not happen.
   */
  send: (
    text: string,
    attachments?: readonly UploadableAttachment[],
    options?: RemoteSendOptions
  ) => Promise<void>
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
  const [attachDowngrade, setAttachDowngrade] = useState<AttachDowngradeReason | null>(null)
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
    let renewal: ReturnType<typeof setInterval> | null = null
    let renewalIntervalMs = ATTACH_LEASE_RENEW_INTERVAL_MS
    // Downgraded to `observe` for the life of this effect once the Host has
    // refused control once; re-asking every renewal is a guaranteed 403.
    let requestedMode: "control" | "observe" = "control"
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
      const attach = async (): Promise<void> => {
        const result = (await transport.call("session_attach", {
          sessionId,
          // Ask for control first. The Host grants it only if this device holds
          // Remote Control AND its event stream has caught up, and answers with
          // what it actually gave — so the fallback to a read-only view is the
          // Host's decision, made against state only it can see, rather than a
          // guess made here. Once a 403 has proved this device has no Remote
          // Control grant, `requestedMode` sticks at `observe`.
          mode: requestedMode,
          // Lets the Host skip a native push for a decision this device is
          // already showing. Re-read on every renewal so backgrounding the app
          // starts producing pushes within one renewal interval.
          attention: documentAttention(),
        })) as AttachResponse | null
        if (cancelled) return
        // An older Host answers `null`; a current one reports the mode it
        // actually granted, plus why it narrowed the request.
        setCanControl(requestedMode === "control" && result?.mode !== "observe")
        setAttachDowngrade(
          requestedMode === "observe" ? "missing-capability" : (result?.downgradeReason ?? null)
        )
        // The Host owns the lease cadence. Adopting the interval it reports
        // means a change there does not need a client release to take effect —
        // and a client renewing on a stale constant would silently lose its
        // attachment between renewals.
        const reported = result?.renewIntervalMs
        if (typeof reported === "number" && reported > 0 && reported !== renewalIntervalMs) {
          renewalIntervalMs = reported
          scheduleRenewal()
        }
      }

      /**
       * Attach, and fall back to an observe attachment on a control refusal.
       *
       * A control request is authorized at the RPC gate against
       * `workspace.write`, so a device without Remote Control never reaches the
       * attach handler at all: without this retry it held NO attachment — not
       * even the read-only one the mode exists for — and the renewal timer
       * re-issued the same 403 every interval for as long as the view was open.
       */
      const attachWithObserveFallback = async (): Promise<void> => {
        try {
          await attach()
        } catch (err) {
          if (cancelled) return
          if (requestedMode === "control" && isControlForbidden(err)) {
            requestedMode = "observe"
            setCanControl(false)
            setAttachDowngrade("missing-capability")
            await attach()
            return
          }
          throw err
        }
      }

      const scheduleRenewal = (): void => {
        if (renewal !== null) clearInterval(renewal)
        renewal = setInterval(() => {
          void attachWithObserveFallback().catch(() => {
            // A failed renewal is not a downgrade: the lease still has ~60s
            // left and the next tick may succeed. Only an explicit rejection
            // clears `canControl`.
          })
        }, renewalIntervalMs)
      }

      try {
        await attachWithObserveFallback()
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

      // The Host's attachment is a lease, not a registration: it lapses after
      // `ATTACH_LEASE_TTL_MS` so a device that vanished stops collecting
      // approval prompts it will never answer. Re-attaching is the renewal —
      // it is idempotent and refreshes the expiry — and at a third of the TTL
      // two consecutive failures can be absorbed before the lease drops.
      scheduleRenewal()

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
      if (renewal !== null) clearInterval(renewal)
      if (messageCommitFrame !== null) cancelAnimationFrame(messageCommitFrame)
      unsub?.()
      if (!sessionId) return
      // Best-effort detach so the host stops routing approvals here. No
      // `deviceId`: the Host releases the authenticated caller's own lease and
      // ignores any id in the payload, so sending one only invited spoofing.
      void transport.call("session_detach", { sessionId }).catch(() => {})
    }
  }, [seedHistory, sessionId, setStatusBoth])

  const send = useCallback(
    async (
      text: string,
      attachments: readonly UploadableAttachment[] = [],
      options?: RemoteSendOptions
    ) => {
      // An attachment with no caption is a message. Requiring text would make
      // "here, look at this screenshot" impossible to send from a phone.
      if (!sessionId || (!text.trim() && attachments.length === 0)) return
      try {
        // Bytes first, refs second. The Host refuses a `message.enqueue` whose
        // ref does not resolve, so uploading after enqueueing would guarantee
        // the rejection; and doing it here rather than inside the queue keeps
        // a 10 MB screenshot out of the durable action row entirely.
        const uploaded: UploadedAttachment[] = []
        for (const [index, attachment] of attachments.entries()) {
          uploaded.push(
            await uploadSessionAttachment(sessionId, attachment, {
              hash: attachment.hash,
              onProgress: (progress) => options?.onUploadProgress?.(index, progress),
            })
          )
        }
        const queued = await enqueueHostStateIntentIfAvailable({
          sessionId,
          action: {
            kind: "message.enqueue",
            messageId: crypto.randomUUID(),
            text,
            attachments: uploaded.map(({ ref, name, mediaType, size, hash }) => ({
              ref,
              name,
              mediaType,
              size,
              hash,
            })),
          },
        })
        // The durable write must win the race with optimism. A negotiated
        // HostState target now owns dispatch; old Hosts retain the direct path.
        setStatusBoth("streaming")
        if (queued) return
        // No HostState target: the direct path has no ref to resolve, so an
        // attachment cannot ride it. Refusing the whole send would be worse
        // than saying so — the text is still worth delivering, and the user is
        // told the files were not.
        if (uploaded.length > 0) toast.warning(t("detail.attachmentsNeedHost"))
        await sendPrompt(sessionId, text)
      } catch (err) {
        setStatusBoth("idle")
        if (isControlForbidden(err)) {
          setCanControl(false)
          toast.warning(t("detail.controlLost"))
        } else {
          toast.error(t("detail.sendFailed", { reason: errReason(err) }))
        }
        throw err
      }
    },
    [sessionId, setStatusBoth, t]
  )

  const interrupt = useCallback(async () => {
    if (!sessionId) return
    // Nothing in flight — don't fire a spurious interrupt RPC.
    if (statusRef.current !== "streaming") return
    try {
      const queued = await enqueueHostStateIntentIfAvailable({
        sessionId,
        action: { kind: "turn.abort" },
      })
      if (queued) {
        setStatusBoth("idle")
        return
      }
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
        const queued = await enqueueHostStateIntentIfAvailable({
          sessionId: approval.sessionId,
          action: {
            kind: "approval.respond",
            requestId: approval.requestId,
            decision,
          },
        })
        if (queued) {
          setPendingApproval(null)
          return
        }
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
    attachDowngrade,
    sessionEnded,
    notFound,
    send,
    interrupt,
    respond,
    reconcileTranscript,
  }
}
