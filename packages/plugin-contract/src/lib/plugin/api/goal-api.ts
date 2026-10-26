/**
 * The plugin contract's share of `lib/plugin/api/goal-api.ts`, which re-exports these.
 */
import type { Goal, GoalConfig, GoalEvent } from "../../../types/goal"

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
