/**
 * `/goal` controller — start / status / pause / resume / stop / list a
 * self-driving goal loop, reusing `GoalRuntime.createGoal` + the headless
 * `runGoalLoopHeadless` (which builds the judge, pumps turns, and returns the
 * terminal status) verbatim against the CLI-local Dexie. The session row must
 * exist first (the runner + judge read `getSession`), so we upsert it.
 *
 * Note: `runGoalLoopHeadless` runs the whole loop and returns once — there is no
 * per-token streaming seam, so progress shows as an activity pill + a final
 * summary rather than live transcript turns.
 */
import type { AppSettings } from "@/lib/claude/types"
import type { Goal } from "@/types/goal"
import { getActiveGoalForSession, listGoalsBySession } from "@/lib/db/goals"
import { getGoalRuntime } from "@/lib/goal/runtime"
import {
  runGoalLoopHeadless,
  type RunGoalLoopResult,
} from "@/lib/scheduler/executors/goal-headless-runner"

import { ensureSessionRow } from "../../agent/cli-session-store"
import { toBuildContext } from "../../config/to-build-context"
import type { ResolvedConfig } from "../../config/schema"
import { errorMessage, truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface GoalControl {
  pauseGoal(id: string): Promise<unknown>
  resumeGoal(id: string): Promise<unknown>
  stopGoal(id: string): Promise<unknown>
}

export interface GoalDeps {
  dispatch: (action: TuiAction) => void
  sessionId: string
  config: ResolvedConfig
  signal: AbortSignal
  ensureSession?: (sessionId: string, config: ResolvedConfig) => Promise<unknown>
  appSettings?: AppSettings | null
  createGoal?: (input: {
    sessionId: string
    rawObjective: string
    appSettings: AppSettings | null
  }) => Promise<Goal>
  runLoop?: (input: {
    sessionId: string
    goalId: string
    appSettings: AppSettings | null
    signal: AbortSignal
  }) => Promise<RunGoalLoopResult>
  getActive?: (sessionId: string) => Promise<Goal | undefined>
  listGoals?: (sessionId: string) => Promise<Goal[]>
  control?: GoalControl
}

function appSettingsOf(deps: GoalDeps): AppSettings | null {
  if (deps.appSettings !== undefined) return deps.appSettings ?? null
  return toBuildContext({ sessionId: deps.sessionId, config: deps.config }).appSettings ?? null
}

export async function goalStart(objective: string, deps: GoalDeps): Promise<void> {
  const text = objective.trim()
  if (!text) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /goal <objective>" })
    return
  }
  await (deps.ensureSession ?? ensureSessionRow)(deps.sessionId, deps.config)
  const appSettings = appSettingsOf(deps)
  const create = deps.createGoal ?? ((input) => getGoalRuntime().createGoal(input))
  const goal = await create({ sessionId: deps.sessionId, rawObjective: text, appSettings })

  deps.dispatch({ type: "ACTIVITY_START", kind: "goal", label: truncate(text) })
  const runLoop = deps.runLoop ?? runGoalLoopHeadless
  try {
    const result = await runLoop({
      sessionId: deps.sessionId,
      goalId: goal.id,
      appSettings,
      signal: deps.signal,
    })
    const tail = result.lastResponse ? `\n${result.lastResponse}` : ""
    if (result.error) {
      deps.dispatch({
        type: "ACTIVITY_END",
        status: "error",
        summary: `Goal ${result.status}: ${result.error}${tail}`,
      })
    } else {
      deps.dispatch({
        type: "ACTIVITY_END",
        status: "done",
        summary: `Goal ${result.status} after ${result.turns} turns.${tail}`,
      })
    }
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `Goal loop crashed: ${errorMessage(err)}`,
    })
  }
}

export async function goalStatus(deps: GoalDeps): Promise<void> {
  const active = await (deps.getActive ?? getActiveGoalForSession)(deps.sessionId)
  if (!active) {
    deps.dispatch({ type: "NOTICE", message: "No active goal in this session." })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Goal "${active.safeObjective}" — ${active.status}`,
  })
}

async function controlActive(
  deps: GoalDeps,
  verb: "pause" | "resume" | "stop",
  run: (control: GoalControl, id: string) => Promise<unknown>
): Promise<void> {
  const active = await (deps.getActive ?? getActiveGoalForSession)(deps.sessionId)
  if (!active) {
    deps.dispatch({ type: "NOTICE", message: "No active goal to " + verb + "." })
    return
  }
  const control = deps.control ?? getGoalRuntime()
  await run(control, active.id)
  deps.dispatch({ type: "NOTICE", message: `Goal ${verb}d.` })
}

export function goalPause(deps: GoalDeps): Promise<void> {
  return controlActive(deps, "pause", (c, id) => c.pauseGoal(id))
}
export function goalResume(deps: GoalDeps): Promise<void> {
  return controlActive(deps, "resume", (c, id) => c.resumeGoal(id))
}
export function goalStop(deps: GoalDeps): Promise<void> {
  return controlActive(deps, "stop", (c, id) => c.stopGoal(id))
}

export async function goalList(deps: GoalDeps): Promise<void> {
  const goals = await (deps.listGoals ?? listGoalsBySession)(deps.sessionId)
  if (goals.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No goals in this session." })
    return
  }
  const lines = goals.map((g) => `  ${g.status.padEnd(9)} ${truncate(g.safeObjective, 50)}`)
  deps.dispatch({ type: "NOTICE", message: `Goals:\n${lines.join("\n")}` })
}
