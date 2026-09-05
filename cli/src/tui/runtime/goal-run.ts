/**
 * Streaming `/goal` runner for the TUI.
 *
 * The `goal-controller` family (`status`/`pause`/`resume`/`stop`/`list`) are db
 * reads/writes that go through the runtime router. *Starting* a goal is
 * different: to show each turn live in the transcript it must drive the same
 * `agent.send` path the chat uses, so it is wired as an App-level effect (where
 * `agent` is in scope) rather than a router call.
 *
 * It reuses every piece of the goal subsystem verbatim — `GoalRuntime.createGoal`
 * (redaction + persistence + goal/loop mutex), `buildGoalJudgeClient`, and the
 * pure `handleTurnComplete` driver — and only adds the CLI glue: build an
 * `advance` from the driver and hand it to {@link runDrivenTurns}. The headless
 * scheduler runner (`goal-headless-runner.ts`) is the non-streaming sibling; this
 * is its interactive counterpart.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { Goal } from "@/types/goal"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import type { LifecycleHookFirer } from "@/lib/claude/hooks/lifecycle-firer"
import { getGoal, getOpenGoalForSession } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"

import { ensureCliDb } from "../../db/bootstrap"
import { ensureSessionRow } from "../../agent/cli-session-store"
import type { ResolvedConfig } from "../../config/schema"
import { resolveAppSettings } from "./goal-controller"
import { runDrivenTurns, type DrivenAdvance } from "./driven-turns"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

/** A judge client builder — `(session, appSettings) => LlmClient | null`. */
type BuildJudge = (
  session: Awaited<ReturnType<typeof getSession>>,
  appSettings: AppSettings | null
) => LlmClient | null

export interface GoalRunDeps {
  send: (prompt: string) => Promise<RunAndCaptureResult | null>
  dispatch: (action: TuiAction) => void
  sessionId: string
  config: ResolvedConfig
  signal: AbortSignal
  /** Drain a queued `btw` steer message (App-owned). */
  takeSteer?: () => string | null
  /** Resume the persisted paused goal instead of creating a new one. */
  resume?: boolean
  getOpenGoal?: typeof getOpenGoalForSession
  resumeGoal?: (id: string) => Promise<Goal | null>
  pauseGoal?: (id: string) => Promise<unknown>
  stopGoal?: (id: string) => Promise<unknown>
  // ── injectable seams (default to the real impls; faked in tests) ──
  ensureDb?: () => Promise<unknown>
  ensureSession?: (sessionId: string, config: ResolvedConfig) => Promise<unknown>
  appSettings?: AppSettings | null
  createGoal?: (input: {
    sessionId: string
    rawObjective: string
    appSettings: AppSettings | null
  }) => Promise<Goal>
  buildJudge?: BuildJudge
  getSession?: (id: string) => Promise<Awaited<ReturnType<typeof getSession>>>
  handleTurn?: typeof handleTurnComplete
  getGoal?: (id: string) => Promise<Goal | undefined>
  /** Lifecycle-hook firer for the judge call (App-owned, CLI runner-backed). */
  firer?: LifecycleHookFirer
}

export async function runGoalStreaming(objective: string, deps: GoalRunDeps): Promise<void> {
  const text = objective.trim()
  if (deps.signal.aborted) return
  if (!text && !deps.resume) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /goal <objective>" })
    return
  }

  const ensureDb = deps.ensureDb ?? (() => ensureCliDb())
  const ensureSession = deps.ensureSession ?? ensureSessionRow
  const createGoal = deps.createGoal ?? ((input) => getGoalRuntime().createGoal(input))
  const buildJudge = deps.buildJudge ?? buildGoalJudgeClient
  const readSession = deps.getSession ?? getSession
  const readGoal = deps.getGoal ?? getGoal
  const handleTurn = deps.handleTurn ?? handleTurnComplete

  await ensureDb()
  await ensureSession(deps.sessionId, deps.config)
  const appSettings = resolveAppSettings(deps.sessionId, deps.config, deps.appSettings)

  if (deps.signal.aborted) return
  let paused: Goal | undefined
  if (deps.resume) {
    paused = await (deps.getOpenGoal ?? getOpenGoalForSession)(deps.sessionId)
    if (!paused || paused.status !== "paused") {
      deps.dispatch({
        type: "NOTICE",
        message: paused
          ? "Goal is already active; pause it before resuming."
          : "No paused goal to resume in this session.",
      })
      return
    }
    if (deps.signal.aborted) return
  }
  const session = await readSession(deps.sessionId)
  const judgeClient = buildJudge(session, appSettings)
  if (!judgeClient) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Goal judge client unavailable — configure a provider that can grade completion.",
    })
    return
  }

  let goal: Goal
  try {
    if (deps.signal.aborted) return
    if (deps.resume) {
      const resumed = await (deps.resumeGoal ?? ((id) => getGoalRuntime().resumeGoal(id)))(
        paused!.id
      )
      if (!resumed || resumed.status !== "active") {
        deps.dispatch({ type: "NOTICE", message: "Goal could not be resumed; its state changed." })
        return
      }
      goal = resumed
    } else {
      goal = await createGoal({ sessionId: deps.sessionId, rawObjective: text, appSettings })
    }
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const advance = async ({
    text: lastResponse,
    tokensDelta,
  }: {
    text: string
    tokensDelta: number
  }): Promise<DrivenAdvance> => {
    const current = await readGoal(goal.id)
    if (!current) return { kind: "stop", status: "error", summary: "Goal removed mid-run." }
    const outcome = await handleTurn({
      goalId: goal.id,
      lastResponse,
      tokensDelta,
      judgeClient,
      signal: deps.signal,
      capturedGenerationId: goal.generationId,
      firer: deps.firer,
      hookContext: {
        agentId: "goal-judge",
        agentKind: "goal-judge",
        sessionId: deps.sessionId,
      },
    })
    switch (outcome.kind) {
      case "continue":
        return { kind: "continue", prompt: outcome.userMessage }
      case "exit":
        return {
          kind: "stop",
          status: "done",
          summary: `Goal ${outcome.resultingStatus}: ${outcome.reason}`,
        }
      case "aborted":
        return { kind: "stop", status: "done", summary: "Goal paused." }
      default:
        // stale / no_goal — the row rotated or vanished; end quietly as error.
        return {
          kind: "stop",
          status: "error",
          summary: `Goal ${outcome.kind}${"reason" in outcome ? `: ${outcome.reason}` : ""}`,
        }
    }
  }

  try {
    await runDrivenTurns({
      send: deps.send,
      firstPrompt: goal.safeObjective,
      advance,
      dispatch: deps.dispatch,
      signal: deps.signal,
      label: truncate(goal.safeObjective),
      kind: "goal",
      max: goal.config.maxTurns,
      takeSteer: deps.takeSteer,
    })
  } finally {
    {
      const current = await readGoal(goal.id)
      if (current?.generationId === goal.generationId && current.status === "active") {
        const control =
          deps.signal.reason === "stop"
            ? (deps.stopGoal ?? ((id: string) => getGoalRuntime().stopGoal(id)))
            : (deps.pauseGoal ?? ((id: string) => getGoalRuntime().pauseGoal(id)))
        await control(goal.id)
      }
    }
  }
}
