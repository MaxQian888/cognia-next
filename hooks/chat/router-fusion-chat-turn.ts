/**
 * A chat turn the send pipeline stamped as a cascade or panel run
 * (ADR-0188 B3, D7/D19/D38).
 *
 * The chat controller hands the turn here after the person's message is in the
 * store and the session is `streaming`, the same point a Squad turn branches.
 * A fusion run is not a sidecar stream: there are no `session_ended` events to
 * settle it, so this module does what the event handler does for a direct
 * turn — keeps the progress card current, shows the verified answer, reports a
 * failure, puts the session back to idle and lets the controller drain the
 * steer queue. Mid-run steering is not offered: a follow-up typed while the
 * run works waits in the queue and becomes the next turn.
 *
 * Loaded statically by the controller, so it imports only the Router + Fusion
 * gate; the engine itself is loaded by the gate, and only for a stamped turn.
 */

import type { UIMessage } from "ai"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { AppSettings, RouterFusionRunStamp } from "@cognia/agent-config-types"

import { stripSteerPrefix } from "@/lib/claude/steer"
import { commitMessageDelta } from "@/lib/db/messages"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import {
  cancelRouterFusionChatRun,
  runRouterFusionChatTurn,
  type RunRouterFusionChatTurnInput,
} from "@/lib/router-fusion/gate/chat-fusion-run"
import { RouterFusionUnavailableError } from "@/lib/router-fusion/gate/faults"
import {
  refusalOf,
  routerFusionRefusalDiagnostic,
  type RouterFusionRefusalDiagnosticInput,
} from "@/lib/router-fusion/gate/refusal-diagnostic"
import { useChatStore } from "@/stores/chat"
import { useFusionProgressStore } from "@/stores/chat/fusion-progress-store"

export type FusionChatTurnResult = "completed" | "failed" | "cancelled"

type FusionMessage = RunRouterFusionChatTurnInput["messages"][number]

/**
 * The conversation as the run reads it: the text of each user, assistant and
 * system message, oldest first. Reasoning, tool calls, files and cards carry no
 * text a fusion run can use; a message with nothing else is left out.
 */
export function fusionTranscriptOf(messages: readonly UIMessage[]): FusionMessage[] {
  const transcript: FusionMessage[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system")
      continue
    const text = (message.parts ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => (message.role === "user" ? stripSteerPrefix(part.text) : part.text))
      .join("\n\n")
      .trim()
    if (text) transcript.push({ role: message.role, content: text })
  }
  return transcript
}

export interface FusionChatTurnInput {
  sessionId: string
  stamp: RouterFusionRunStamp
  /** The conversation the provider reads, the new message last. */
  messages: readonly UIMessage[]
  /** The person's new message, to make durable; `null` when it already is (a regenerate or a steer replay). */
  userMessage: UIMessage | null
  workspaceRoot: string | null
  settings: AppSettings | null | undefined
  /** The turn settled; the controller drains its steer queue and records telemetry. */
  onSettled?: (result: FusionChatTurnResult) => void
}

export interface FusionChatTurnDeps {
  runTurn: typeof runRouterFusionChatTurn
  cancelRun: typeof cancelRouterFusionChatRun
  commitUserMessage: (sessionId: string, message: UIMessage) => Promise<unknown>
  refusalDiagnostic: (input: RouterFusionRefusalDiagnosticInput) => Promise<CogniaDiagnostic>
  now: () => number
}

const defaultDeps: FusionChatTurnDeps = {
  runTurn: runRouterFusionChatTurn,
  cancelRun: cancelRouterFusionChatRun,
  commitUserMessage: (sessionId, message) => commitMessageDelta(sessionId, { upserts: [message] }),
  refusalDiagnostic: routerFusionRefusalDiagnostic,
  now: () => Date.now(),
}

interface ActiveTurn {
  runId: string
  controller: AbortController
  /** Stopped by the person: the run's own outcome is reported as `cancelled`. */
  stopped: boolean
  /** The stop already put the session back to idle, so the settle leaves it alone. */
  settledByStop: boolean
}

/** The fusion turn in flight in each session of this window. */
const turns = new Map<string, ActiveTurn>()

/** Whether `sessionId` is running a fusion turn: a follow-up waits in the queue. */
export function fusionChatTurnActive(sessionId: string): boolean {
  return turns.has(sessionId)
}

export function __resetFusionChatTurnsForTesting(): void {
  turns.clear()
}

async function failureDiagnostic(
  error: unknown,
  sessionId: string,
  deps: Pick<FusionChatTurnDeps, "refusalDiagnostic">
): Promise<CogniaDiagnostic> {
  const refusal = refusalOf(error)
  if (refusal) return deps.refusalDiagnostic({ ...refusal, sessionId })
  if (error instanceof RouterFusionUnavailableError) {
    // Explicit fusion work is never answered by the ordinary path instead (D38).
    return deps.refusalDiagnostic({
      code: error.code,
      reasons: [error.fault.code],
      sessionId,
      kind: "failed",
    })
  }
  return toDiagnostic(error instanceof Error ? error : new Error(String(error)), {
    source: "chat",
    meta: { sessionId },
  })
}

/**
 * The chat diagnostic for a Router + Fusion error raised while a send was
 * being routed: a refusal, or an unavailable Router + Fusion for a cascade or
 * panel the person asked for. `null` for any other error.
 */
export async function routerFusionSendDiagnostic(
  error: unknown,
  sessionId: string,
  deps: Pick<FusionChatTurnDeps, "refusalDiagnostic"> = defaultDeps
): Promise<CogniaDiagnostic | null> {
  if (!refusalOf(error) && !(error instanceof RouterFusionUnavailableError)) return null
  return failureDiagnostic(error, sessionId, deps)
}

/**
 * Run the stamped turn to its end. Never throws: every outcome ends with the
 * session idle and, unless the person stopped it, a verified answer or a
 * diagnostic in the chat.
 */
export async function runFusionChatTurn(
  input: FusionChatTurnInput,
  deps: FusionChatTurnDeps = defaultDeps
): Promise<FusionChatTurnResult> {
  const { sessionId, stamp } = input
  const chat = () => useChatStore.getState()
  const progress = useFusionProgressStore.getState()
  // An earlier turn in this session cannot still be running: the session was
  // streaming, and a send while streaming is a steer. Replace defensively.
  turns.get(sessionId)?.controller.abort()
  const turn: ActiveTurn = {
    runId: stamp.runId,
    controller: new AbortController(),
    stopped: false,
    settledByStop: false,
  }
  turns.set(sessionId, turn)
  progress.start(sessionId, {
    runId: stamp.runId,
    mode: stamp.mode,
    startedAt: deps.now(),
    capMicrousd: stamp.capMicrousd,
  })

  const current = () => turns.get(sessionId) === turn
  const settle = (outcome: FusionChatTurnResult, diagnostic: CogniaDiagnostic | null) => {
    // Whatever the run says, a turn the person stopped ended by their hand.
    const result = turn.stopped ? "cancelled" : outcome
    // A plain Stop already settled the session, and a newer turn owns its
    // status once this one is no longer current.
    if (current() && !turn.settledByStop) {
      chat().setSessionStatus(sessionId, "idle")
      // After the idle flip: a diagnostic moves the session to `error`.
      if (diagnostic && !turn.stopped) chat().setSessionDiagnostic(sessionId, diagnostic)
      chatTurnPerformance.finish(sessionId, result)
    }
    input.onSettled?.(result)
    return result
  }

  try {
    if (input.userMessage) {
      // Durable before the run starts, like the direct path's acceptance. A
      // delta, not a whole-transcript write: that would delete what we do not hold.
      await deps.commitUserMessage(sessionId, input.userMessage).catch((error: unknown) => {
        console.error("[router-fusion] the chat message could not be saved", error)
      })
    }
    let outcome: Awaited<ReturnType<typeof runRouterFusionChatTurn>>
    try {
      outcome = await deps.runTurn({
        sessionId,
        stamp,
        messages: fusionTranscriptOf(input.messages),
        workspaceRoot: input.workspaceRoot,
        settings: input.settings,
        signal: turn.controller.signal,
        onProgress: (summary) => useFusionProgressStore.getState().update(sessionId, summary),
      })
    } catch (error) {
      return settle("failed", await failureDiagnostic(error, sessionId, deps))
    }
    switch (outcome.kind) {
      case "succeeded":
        // The answer is already in the transcript table (the run's outbox);
        // the chat shows it now, stopped or not, because it is durable.
        chat().upsertSessionMessages(sessionId, [outcome.answer as unknown as UIMessage])
        return settle("completed", null)
      case "cancelled":
        return settle("cancelled", null)
      case "refused":
        return settle(
          "failed",
          await deps.refusalDiagnostic({
            code: outcome.code,
            ...(outcome.activeRunId ? { reasons: [outcome.activeRunId] } : {}),
            sessionId,
          })
        )
      default:
        return settle(
          "failed",
          await deps.refusalDiagnostic({
            code: outcome.code,
            // The run itself stays in Agent Runs; its id finds it there.
            reasons: [outcome.message, `run ${stamp.runId}`],
            sessionId,
            kind: "failed",
          })
        )
    }
  } finally {
    useFusionProgressStore.getState().clear(sessionId, stamp.runId)
    if (current()) turns.delete(sessionId)
  }
}

/**
 * The person stopped the turn. The run moves to cancelling and its calls are
 * aborted. `settled`: the caller (a plain Stop) already put the session back to
 * idle; otherwise (interrupt and steer) the turn's own settle does, and the
 * controller replays the queue from it. A no-op for a session with no fusion
 * turn.
 */
export async function stopFusionChatTurn(
  sessionId: string,
  settings: AppSettings | null | undefined,
  options: { settled: boolean },
  deps: Pick<FusionChatTurnDeps, "cancelRun"> = defaultDeps
): Promise<void> {
  const turn = turns.get(sessionId)
  if (!turn) return
  turn.stopped = true
  turn.settledByStop = options.settled
  useFusionProgressStore.getState().clear(sessionId, turn.runId)
  try {
    await deps.cancelRun(sessionId, { settings })
  } finally {
    turn.controller.abort()
  }
}
