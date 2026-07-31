/**
 * Plugin Goal API — lets plugins read and drive the user's self-driving
 * goals (`/goal`). Productivity / automation plugins can create goals,
 * track progress, decompose objectives into sub-goals, and react to
 * lifecycle transitions (via the existing `onScheduledTask*` / goal hooks).
 *
 * Design:
 *  - Reads go straight to the `@/lib/db/goals` Dexie layer.
 *  - Mutations route through `getGoalRuntime()` so the runtime's
 *    side-effects fire (abort-controller teardown, audit rows, IM opt-in
 *    guardrail, plugin event hooks). No git-plumbing-style reimplementation.
 *  - Sub-goal decomposition needs a judge-capable LLM; we build the same
 *    renderer LLM client the Goals console uses (`buildRendererLlmClient`)
 *    from the goal's session + app settings, so plugins don't have to
 *    thread a model client themselves. Throws when no judge model is
 *    configured (legacy env-key users can't self-drive — parity with the UI).
 *  - Gated by `goal:read` (reads) / `goal:write` (mutations).
 */

import { getGoalRuntime } from "@/lib/goal/runtime"
import {
  getGoal,
  listAllGoals,
  listGoalsBySession,
  getActiveGoalForSession,
  getOpenGoalForSession,
  listGoalEvents,
} from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { Goal, GoalConfig, GoalEvent } from "@/types/goal"

export interface PluginGoalCreateInput {
  /** Chat session the goal drives. */
  sessionId: string
  /** Natural-language objective (redacted + persisted by the runtime). */
  rawObjective: string
  /** Optional character/persona binding. */
  characterId?: string
  /** Partial overrides for pacing / exit-condition config. */
  config?: Partial<GoalConfig>
  /** Create the goal paused instead of immediately active. */
  startPaused?: boolean
}

/** Goal driving + tracking API exposed to plugins. */
export interface PluginGoalAPI {
  // --------------------------------------------------------------- reads
  /** Fetch a goal by id, or `null` if it doesn't exist. */
  get(goalId: string): Promise<Goal | null>
  /** All goals bound to a session (newest first). */
  listBySession(sessionId: string): Promise<Goal[]>
  /** Every goal across all sessions (bounded by `limit`, default 500). */
  listAll(limit?: number): Promise<Goal[]>
  /** The active (running) goal for a session, if any. */
  getActiveForSession(sessionId: string): Promise<Goal | null>
  /** The open (active or paused) goal for a session, if any. */
  getOpenForSession(sessionId: string): Promise<Goal | null>
  /** The goal's event timeline (created/step/judged/…), newest-last. */
  getEvents(goalId: string, limit?: number): Promise<GoalEvent[]>

  // ----------------------------------------------------------- mutations
  /** Create + start (or pause) a goal on a session. */
  create(input: PluginGoalCreateInput): Promise<Goal>
  /** Replace the objective text. */
  updateObjective(goalId: string, rawObjective: string): Promise<Goal | null>
  /** Pause a running goal. */
  pause(goalId: string): Promise<Goal | null>
  /** Resume a paused goal. */
  resume(goalId: string): Promise<Goal | null>
  /** Stop a goal (user-terminal). */
  stop(goalId: string): Promise<Goal | null>
  /** Preempt a goal (system-terminal, e.g. superseded). */
  preempt(goalId: string): Promise<Goal | null>
  /** Patch the goal's pacing / exit-condition config. */
  updateConfig(goalId: string, patch: Partial<GoalConfig>): Promise<Goal | null>
  /** Decompose the objective into a sub-goal checklist via the judge model. */
  decomposeSubgoals(goalId: string): Promise<Goal | null>
  /** Toggle a single sub-goal's done state. */
  toggleSubgoal(goalId: string, subgoalId: string): Promise<Goal | null>
  /** Clear the sub-goal checklist. */
  clearSubgoals(goalId: string): Promise<Goal | null>
  /** Delete a goal and its events. */
  delete(goalId: string): Promise<void>
}

/** Thrown when sub-goal decomposition has no judge-capable model to use. */
export class NoJudgeModelError extends Error {
  constructor() {
    super(
      "ctx.goals.decomposeSubgoals: no judge-capable model is configured — sub-goal decomposition is unavailable."
    )
    this.name = "NoJudgeModelError"
  }
}

/**
 * Create the Goal API for a plugin. Reads need `goal:read`; every
 * mutation needs `goal:write` (enforced via the PermissionGuard proxy).
 */
export function createGoalAPI(pluginId: string): PluginGoalAPI {
  const runtime = getGoalRuntime()

  const api: PluginGoalAPI = {
    // reads
    get: async (goalId) => (await getGoal(goalId)) ?? null,
    listBySession: (sessionId) => listGoalsBySession(sessionId),
    listAll: (limit) => listAllGoals(limit),
    getActiveForSession: async (sessionId) => (await getActiveGoalForSession(sessionId)) ?? null,
    getOpenForSession: async (sessionId) => (await getOpenGoalForSession(sessionId)) ?? null,
    getEvents: (goalId, limit) => listGoalEvents(goalId, limit),

    // mutations
    create: (input) =>
      runtime.createGoal({
        sessionId: input.sessionId,
        rawObjective: input.rawObjective,
        characterId: input.characterId,
        config: input.config,
        startPaused: input.startPaused,
        appSettings: useSettingsStore.getState().settings,
        // Headless: no operator to hold turns for (ADR-0070 Phase 2).
        origin: "plugin",
      }),
    updateObjective: async (goalId, rawObjective) => {
      // The runtime returns `{ goal, updatePrompt }` (the prompt is for the
      // turn-driver's regeneration); plugins just want the updated Goal.
      const result = await runtime.updateObjective(goalId, rawObjective)
      return result?.goal ?? null
    },
    pause: (goalId) => runtime.pauseGoal(goalId),
    resume: (goalId) => runtime.resumeGoal(goalId),
    stop: (goalId) => runtime.stopGoal(goalId),
    preempt: (goalId) => runtime.preemptGoal(goalId),
    updateConfig: (goalId, patch) => runtime.updateConfig(goalId, patch),
    decomposeSubgoals: async (goalId) => {
      const goal = await getGoal(goalId)
      if (!goal) return null
      const session = await getSession(goal.sessionId)
      const client = buildRendererLlmClient({
        session,
        appSettings: useSettingsStore.getState().settings,
        featureId: "goal-subgoals",
      })
      if (!client) throw new NoJudgeModelError()
      return runtime.generateSubgoals(goalId, client)
    },
    toggleSubgoal: (goalId, subgoalId) => runtime.toggleSubgoal(goalId, subgoalId),
    clearSubgoals: (goalId) => runtime.clearSubgoals(goalId),
    delete: (goalId) => runtime.deleteGoal(goalId),
  }

  return createGuardedAPI(pluginId, api, {
    get: "goal:read",
    listBySession: "goal:read",
    listAll: "goal:read",
    getActiveForSession: "goal:read",
    getOpenForSession: "goal:read",
    getEvents: "goal:read",
    create: "goal:write",
    updateObjective: "goal:write",
    pause: "goal:write",
    resume: "goal:write",
    stop: "goal:write",
    preempt: "goal:write",
    updateConfig: "goal:write",
    decomposeSubgoals: "goal:write",
    toggleSubgoal: "goal:write",
    clearSubgoals: "goal:write",
    delete: "goal:write",
  })
}
