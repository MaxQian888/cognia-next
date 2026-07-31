/**
 * `runDrivenTurns` — the shared streamed turn-pump behind self-driving `/goal`
 * and `/loop` in the TUI.
 *
 * Both features need the same loop: send a prompt as an ordinary chat turn (so
 * it streams into the transcript), capture the reply + token delta, hand it to a
 * pure decision function (`advance`), then either send the next prompt or stop.
 * The differences (judge vs. trailer parsing, fixed vs. model-decided delay)
 * live entirely in the caller-supplied `advance`; this module owns only the
 * mechanics — activity pill, abort handling, inter-turn delay, and the `btw`
 * steer drain.
 *
 * **Steering (`btw`):** between turns the pump calls `takeSteer()`. A queued
 * steer message REPLACES the next continuation prompt for one turn (framed so
 * the model treats it as a mid-run aside) and skips the pacing delay so the run
 * responds to the user promptly. The autonomous decision (`advance`) still runs
 * on the steered turn's reply, so the run continues from there.
 */

import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { formatTokens } from "../format/usage"
import type { ActivityKind, TuiAction } from "../state/types"

export interface DrivenAdvanceInput {
  /** The just-completed turn's assistant text. */
  text: string
  /** input + output tokens for the turn (0 when unknown). */
  tokensDelta: number
}

export type DrivenAdvance =
  | { kind: "continue"; prompt: string; delayMs?: number; note?: string }
  | { kind: "stop"; status: "done" | "error"; summary: string }

export interface DrivenTurnsDeps {
  /** Stream one turn into the transcript; resolves the captured reply, or
   * `null` when the turn errored (timeout / crash / abort). */
  send: (prompt: string) => Promise<RunAndCaptureResult | null>
  /** The first prompt to send (redacted objective / first iteration message). */
  firstPrompt: string
  /** Decide the next step from the completed turn. Pure side of the loop. */
  advance: (input: DrivenAdvanceInput) => Promise<DrivenAdvance>
  dispatch: (action: TuiAction) => void
  signal: AbortSignal
  /** Activity-pill label + kind. */
  label: string
  kind: Extract<ActivityKind, "goal" | "loop">
  /** Known iteration cap (loop `--n`, goal `maxTurns`) → determinate progress
   * bar in the activity pill. Omit for an open-ended run. */
  max?: number
  /** Drain a queued `btw` steer message; `null` when nothing is queued. */
  takeSteer?: () => string | null
  /** Sleep `ms`, resolving early when `signal` aborts. Injected in tests. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Defensive cap so a wedged `advance` can't spin forever. */
  hardCap?: number
}

const DEFAULT_HARD_CAP = 200

/** Default delay: a single `setTimeout` race against the abort signal. */
function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    const onAbort = () => done()
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Frame a steer message so the model reads it as a mid-run aside, not a new task. */
export function frameSteer(steer: string): string {
  return `By the way (steering): ${steer}`
}

export async function runDrivenTurns(deps: DrivenTurnsDeps): Promise<void> {
  const { send, advance, dispatch, signal, takeSteer } = deps
  const delay = deps.delay ?? defaultDelay
  const hardCap = deps.hardCap ?? DEFAULT_HARD_CAP

  dispatch({
    type: "ACTIVITY_START",
    kind: deps.kind,
    label: deps.label,
    ...(deps.max !== undefined ? { max: deps.max } : {}),
  })

  let nextPrompt = deps.firstPrompt
  let turns = 0
  // Run-scoped token total — surfaced as the activity-pill note so a long run
  // shows live consumption ("how much has this goal/loop burned so far").
  let totalTokens = 0

  try {
    while (turns < hardCap) {
      if (signal.aborted) {
        dispatch({
          type: "ACTIVITY_END",
          status: "done",
          summary: `${cap(deps.kind)} stopped after ${turns} turn${turns === 1 ? "" : "s"}.`,
        })
        return
      }

      turns += 1
      dispatch({ type: "ACTIVITY_PROGRESS", turns })
      const result = await send(nextPrompt)
      if (result === null) {
        dispatch({
          type: "ACTIVITY_END",
          status: "error",
          summary: `${cap(deps.kind)} interrupted — the turn failed.`,
        })
        return
      }

      const tokensDelta = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
      totalTokens += tokensDelta
      const decision = await advance({ text: result.text, tokensDelta })

      if (decision.kind === "stop") {
        dispatch({ type: "ACTIVITY_END", status: decision.status, summary: decision.summary })
        return
      }

      // Update the pill note with run-scoped consumption (+ any caller note,
      // e.g. an interval loop's "next in 30s"), shown during the inter-turn gap.
      const tokenNote = `${formatTokens(totalTokens)} tok`
      dispatch({
        type: "ACTIVITY_PROGRESS",
        note: decision.note ? `${decision.note} · ${tokenNote}` : tokenNote,
      })

      // continue — a queued steer overrides the auto-continuation (and skips the
      // pacing delay so the run answers the user promptly).
      const steer = takeSteer?.() ?? null
      if (steer !== null) {
        nextPrompt = frameSteer(steer)
        continue
      }
      nextPrompt = decision.prompt
      if (decision.delayMs && decision.delayMs > 0) {
        await delay(decision.delayMs, signal)
      }
    }

    dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `${cap(deps.kind)} hit the ${hardCap}-turn safety cap.`,
    })
  } catch (err) {
    dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `${cap(deps.kind)} crashed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
