import type { UIMessage } from "ai"
import type { ClaudeEvent, SDKMessage } from "@cognia/agent-config-types"

import { applySdkEvent } from "@/lib/claude/adapter"
import { onClaudeMessage } from "@/lib/claude/ipc"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { listWorkSubmissions } from "@/lib/db/work-submissions"

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
  applyEvent?: (messages: UIMessage[], event: SDKMessage) => { messages: UIMessage[] }
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
  persist: typeof persistMessages
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
        const current = mirrors.get(event.sessionId) ?? (await load(event.sessionId))
        const projected = project(current, event.event).messages
        mirrors.set(event.sessionId, projected)
      })
    } else if (event.type === "session_ended") {
      enqueue(event.sessionId, async () => {
        const messages = mirrors.get(event.sessionId)
        await settleSession(event.sessionId, {
          outcome: event.error ? "failed" : "completed",
          ...(event.error ? { errorCode: "turn_error" } : {}),
          ...(messages ? { writeTranscript: () => persist(event.sessionId, messages) } : {}),
        })
        mirrors.delete(event.sessionId)
        activeSessions.delete(event.sessionId)
      })
    } else if (event.type === "sidecar_exited") {
      void Promise.all([...queues.values()].map((queue) => queue.catch(() => undefined)))
        .then(() => settleSidecarExit(deps, mirrors, load, persist))
        .catch((error) => deps.onError?.(error))
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
