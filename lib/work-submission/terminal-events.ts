import { personChatCapability } from "@/lib/headless/person-chat"
import type { UIMessage } from "ai"
import type { ClaudeEvent, SDKMessage, SDKResultMessage } from "@cognia/agent-config-types"

import { applySdkEvent } from "@/lib/claude/adapter"
import { onClaudeMessage } from "@/lib/claude/ipc"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { recordResultUsage } from "@/lib/db/session-usage"
import { getSession } from "@/lib/db/sessions"
import { listWorkSubmissions } from "@/lib/db/work-submissions"
import { isTurnUsageClaimed } from "@/lib/usage/claimed-turn-usage"

import { settleChatTurnForSession } from "./chat-adapter"
import { settleWorkSubmission } from "./service"
import type { Unsubscribe } from "./outbox-runner"

interface WorkSubmissionTerminalEventDeps {
  subscribe?: (handler: (event: ClaudeEvent) => void) => Promise<Unsubscribe>
  settleSession?: typeof settleChatTurnForSession
  listDispatched?: () => ReturnType<typeof listWorkSubmissions>
  settleSubmission?: typeof settleWorkSubmission
  hasOpenSubmission?: (sessionId: string) => Promise<boolean>
  loadMessages?: typeof listMessages
  persistMessages?: typeof persistMessages
  applyEvent?: (
    messages: UIMessage[],
    event: SDKMessage
  ) => { messages: UIMessage[]; result?: SDKResultMessage }
  /** Book a turn's usage row; the chat view's own `recordResultUsage` call. */
  recordUsage?: typeof recordResultUsage
  loadSession?: typeof getSession
  onReady?: () => void
  onError?: (error: unknown) => void
  retryMs?: number
}

let interactiveConsumers = 0

/**
 * Tell the global listener that the full chat event pipeline is mounted.
 *
 * That pipeline owns routing fallback decisions; the global listener must not
 * settle a failed provider attempt while the UI is about to retry it. Outside
 * chat routes (and in the headless host), the global listener owns settlement.
 */
export function registerInteractiveWorkSubmissionEvents(): Unsubscribe {
  interactiveConsumers += 1
  let active = true
  return () => {
    if (!active) return
    active = false
    interactiveConsumers = Math.max(0, interactiveConsumers - 1)
  }
}

async function settleSidecarExit(
  deps: WorkSubmissionTerminalEventDeps,
  mirrors: Map<string, UIMessage[]>,
  load: typeof listMessages,
  persist: (sessionId: string, messages: UIMessage[]) => Promise<void>
): Promise<void> {
  const rows = await (deps.listDispatched?.() ??
    listWorkSubmissions({ dispatchStates: ["dispatched"], limit: 1000 }))
  const settle = deps.settleSubmission ?? settleWorkSubmission
  await Promise.all(
    rows.map(async (row) => {
      const messages = row.sessionId
        ? (mirrors.get(row.sessionId) ?? (await load(row.sessionId)))
        : undefined
      return settle({
        submissionId: row.id,
        outcome: "failed",
        errorCode: "sidecar_exit",
        ...(row.sessionId && messages
          ? { writeTranscript: () => persist(row.sessionId!, messages) }
          : {}),
      })
    })
  )
}

/**
 * Settle dispatched work even when no chat page is mounted.
 *
 * The listener is process-global through the renderer/headless bootstrap. The
 * richer interactive event consumer temporarily takes precedence because it
 * alone can decide whether a provider error will be retried through fallback.
 */
export function startWorkSubmissionTerminalEvents(
  deps: WorkSubmissionTerminalEventDeps = {}
): Unsubscribe {
  let stopped = false
  let unlisten: Unsubscribe | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let ready = false
  const queues = new Map<string, Promise<void>>()
  const mirrors = new Map<string, UIMessage[]>()
  const activeSessions = new Set<string>()
  const subscribe = deps.subscribe ?? onClaudeMessage
  const settleSession = deps.settleSession ?? settleChatTurnForSession
  const load = deps.loadMessages ?? listMessages
  const persist = deps.persistMessages ?? persistMessages
  const project = deps.applyEvent ?? applySdkEvent
  const recordUsage = deps.recordUsage ?? recordResultUsage
  const loadSession = deps.loadSession ?? getSession
  /**
   * Book the turn's usage, as the chat view does for the turns it renders
   * (`hooks/chat/claude-chat-events.ts`). A turn this listener settles is one
   * no chat view is rendering: the Host runs it for a paired device or an org
   * member, so without this the turn's spend was recorded nowhere. Same row
   * key (the reply's message id) and fields, so a chat view that also books
   * the turn overwrites one row, and a turn a headless caller claimed is left
   * to that caller. A failed write never holds up the settlement.
   */
  const recordTurnUsage = async (
    sessionId: string,
    messages: UIMessage[],
    result: SDKResultMessage,
    turnId: string | undefined
  ) => {
    if (isTurnUsageClaimed(sessionId, turnId)) return
    const reply = [...messages].reverse().find((message) => message.role === "assistant")
    if (!reply) return
    try {
      const session = await loadSession(sessionId).catch(() => undefined)
      await recordUsage({
        sessionId,
        messageId: reply.id,
        characterId: session?.characterId,
        model: session?.model,
        providerId: session?.providerOverride,
        ...(session?.projectId ? { projectId: session.projectId } : {}),
        ...(turnId ? { turnId } : {}),
        result,
      })
    } catch (error) {
      deps.onError?.(error)
    }
  }
  // The rows each mirror was loaded from. A row written after that is not the
  // mirror's to delete: the Host writes a message sent mid-turn when it
  // accepts it, while the running turn's mirror is already loaded, and the
  // turn's settlement replaces the transcript with that mirror.
  const bases = new Map<string, Set<string>>()
  const persistMirror = async (sessionId: string, messages: UIMessage[]) => {
    const base = bases.get(sessionId)
    if (!base) return persist(sessionId, messages)
    const held = new Set(messages.map((message) => message.id))
    const arrived = (await load(sessionId)).filter(
      (message) => !base.has(message.id) && !held.has(message.id)
    )
    return persist(sessionId, arrived.length > 0 ? [...messages, ...arrived] : messages)
  }
  const loadMirror = async (sessionId: string) => {
    const messages = await load(sessionId)
    bases.set(sessionId, new Set(messages.map((message) => message.id)))
    return messages
  }
  const hasOpenSubmission =
    deps.hasOpenSubmission ??
    (async (sessionId: string) => {
      const rows = await listWorkSubmissions({
        sessionId,
        dispatchStates: ["pending", "blocked", "claimed", "dispatched"],
        limit: 1,
      })
      return rows.length > 0
    })

  const enqueue = (sessionId: string, task: () => Promise<void>) => {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    queues.set(sessionId, next)
    void next
      .catch((error) => deps.onError?.(error))
      .finally(() => {
        if (queues.get(sessionId) === next) queues.delete(sessionId)
      })
  }

  const handleEvent = (event: ClaudeEvent) => {
    if (stopped || interactiveConsumers > 0) return
    if (event.type === "event") {
      enqueue(event.sessionId, async () => {
        if (!activeSessions.has(event.sessionId)) {
          if (!(await hasOpenSubmission(event.sessionId))) return
          activeSessions.add(event.sessionId)
        }
        const current = mirrors.get(event.sessionId) ?? (await loadMirror(event.sessionId))
        const applied = project(current, event.event)
        mirrors.set(event.sessionId, applied.messages)
        if (applied.result) {
          const turnId = (event as { turnId?: unknown }).turnId
          await recordTurnUsage(
            event.sessionId,
            applied.messages,
            applied.result,
            typeof turnId === "string" ? turnId : undefined
          )
        }
      })
    } else if (event.type === "session_ended") {
      enqueue(event.sessionId, async () => {
        const personChat =
          personChatCapability().chat === "tool-less"
            ? await import("@/lib/claude/person-chat-turn")
            : null
        const terminal = personChat ? await personChat.personChatTerminalEvent(event) : event
        if (!terminal) return
        try {
          const messages = mirrors.get(event.sessionId)
          await settleSession(event.sessionId, {
            outcome: terminal.error ? "failed" : "completed",
            ...(terminal.error ? { errorCode: terminal.code ?? "turn_error" } : {}),
            ...(terminal.resetAt !== undefined ? { resetAt: terminal.resetAt } : {}),
            ...(messages
              ? { writeTranscript: () => persistMirror(event.sessionId, messages) }
              : {}),
          })
          mirrors.delete(event.sessionId)
          bases.delete(event.sessionId)
          activeSessions.delete(event.sessionId)
        } finally {
          // Only now is the reply in the history the next queued turn reads.
          personChat?.endPersonChatTurn(event.sessionId)
        }
      })
    } else if (event.type === "sidecar_exited") {
      void Promise.all([...queues.values()].map((queue) => queue.catch(() => undefined)))
        .then(() => settleSidecarExit(deps, mirrors, load, persistMirror))
        .catch((error) => deps.onError?.(error))
        .finally(() => {
          // No turn the runtime held will report its end now.
          if (personChatCapability().chat !== "tool-less") return
          void import("@/lib/claude/person-chat-turn")
            .then((personChat) => personChat.endAllPersonChatTurns())
            .catch((error) => deps.onError?.(error))
        })
    }
  }

  const connect = () => {
    void subscribe(handleEvent)
      .then((stop) => {
        if (stopped) stop()
        else {
          unlisten = stop
          if (!ready) {
            ready = true
            deps.onReady?.()
          }
        }
      })
      .catch((error) => {
        deps.onError?.(error)
        if (!stopped) retryTimer = setTimeout(connect, deps.retryMs ?? 1_000)
      })
  }
  connect()

  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    unlisten?.()
  }
}
