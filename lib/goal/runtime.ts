/**
 * GoalRuntime — the renderer-side singleton that owns goal lifecycle.
 *
 * Responsibilities:
 *  - `createGoal()`           — redact, persist, log `goal_created`.
 *  - `updateObjective()`      — re-redact, mutate row, bump generationId,
 *                                log `objective_updated`, return the
 *                                update prompt the chat hook should send.
 *  - `pauseGoal()` / `resumeGoal()` / `stopGoal()` — status transitions
 *                                with generationId rotation + event log
 *                                + AbortController fan-out.
 *  - `registerAbortController(goalId, ac)` — turn driver registers its
 *                                signal so a pause / stop / update can
 *                                fire it before the next persist.
 *  - `getDefaults()`          — resolves the effective GoalConfig from
 *                                AppSettings.goals (falling back to
 *                                `DEFAULT_GOAL_CONFIG`).
 *
 * The runtime is **import-side singleton** — there's exactly one per
 * renderer process. Tests reset it via `__resetGoalRuntimeForTesting()`.
 *
 * **Why a singleton vs a per-session class:** the chat hook is mounted
 * once at the top of the chat page and must reach into goal lifecycle
 * from slash command handlers, the turn driver callback, and the
 * composer's preempt detection. A free-floating singleton keeps the
 * import surface minimal — every consumer calls
 * `getGoalRuntime().<method>` and doesn't need to thread an instance
 * through React props or context.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { Goal, GoalConfig, GoalDefaults, GoalStatus } from "@/types/goal"
import { isTerminalGoalStatus } from "@/types/goal"
import {
  appendGoalEvent,
  createGoal,
  deleteGoal,
  getActiveGoalForSession,
  getGoal,
  getOpenGoalForSession,
  listGoalsBySession,
  updateGoal,
} from "@/lib/db/goals"
import { redactObjective } from "./redact-objective"
import { renderObjectiveUpdatedMessage } from "./prompts"

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard-coded defaults applied when `AppSettings.goals` is absent. The
 * numbers come from the three-product survey:
 *   - maxTurns: 20  — Hermes default (`hermes_cli/goals.py`).
 *   - maxTokens: 200_000 — covers ~50 turns of a chatty Sonnet response.
 *   - maxJudgeFailures: 3 — Hermes default; balances flakiness tolerance
 *     against indefinite wedging.
 *   - timeoutMs: 30 min — long enough for a real task, short enough that
 *     a runaway loop can't bill 8 hours of judge calls.
 */
export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

/**
 * Resolve the effective per-goal config from a settings snapshot. Caller
 * supplies overrides for explicit `/goal --max-turns N` style invocations.
 */
export function resolveGoalConfig(
  appSettings: AppSettings | null | undefined,
  overrides: Partial<GoalConfig> = {}
): GoalConfig {
  const defaults = (appSettings as { goals?: GoalDefaults } | null | undefined)?.goals
  return {
    maxTurns: overrides.maxTurns ?? defaults?.maxTurns ?? DEFAULT_GOAL_CONFIG.maxTurns,
    maxTokens: overrides.maxTokens ?? defaults?.maxTokens ?? DEFAULT_GOAL_CONFIG.maxTokens,
    maxJudgeFailures:
      overrides.maxJudgeFailures ??
      defaults?.maxJudgeFailures ??
      DEFAULT_GOAL_CONFIG.maxJudgeFailures,
    timeoutMs: overrides.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs,
    inlineStopCondition: overrides.inlineStopCondition,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────────────────

interface AbortRegistration {
  goalId: string
  controller: AbortController
}

class GoalRuntime {
  /** Per-goal active turn-driver abort controllers. */
  private aborters = new Map<string, AbortRegistration>()

  /**
   * Register the AbortController for an in-flight turn driver. The runtime
   * fires it whenever the goal status mutates externally (pause / stop /
   * update). Returns an unregister function the driver should call on
   * completion.
   */
  registerAbortController(goalId: string, controller: AbortController): () => void {
    this.aborters.set(goalId, { goalId, controller })
    return () => {
      const existing = this.aborters.get(goalId)
      if (existing?.controller === controller) {
        this.aborters.delete(goalId)
      }
    }
  }

  /** Internal helper — abort any in-flight controller for a goal. */
  private fireAbort(goalId: string): void {
    const reg = this.aborters.get(goalId)
    if (!reg) return
    this.aborters.delete(goalId)
    if (!reg.controller.signal.aborted) {
      reg.controller.abort()
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CRUD wrappers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a fresh goal for a session. If the session already has an open
   * (active | paused) goal, it's terminated as `stopped` first so the
   * session-scoped uniqueness invariant holds.
   */
  async createGoal(input: {
    sessionId: string
    characterId?: string
    rawObjective: string
    config?: Partial<GoalConfig>
    nameHints?: Iterable<string>
    appSettings?: AppSettings | null
    startPaused?: boolean
  }): Promise<Goal> {
    const existing = await getOpenGoalForSession(input.sessionId)
    if (existing) {
      this.fireAbort(existing.id)
      await updateGoal(existing.id, { status: "stopped", generationId: crypto.randomUUID() })
      await appendGoalEvent({
        goalId: existing.id,
        kind: "user_stopped",
        payload: { kind: "user_stopped" },
      })
    }
    const config = resolveGoalConfig(input.appSettings ?? null, input.config ?? {})
    const { safeObjective, redactionMapEnc } = await redactObjective(
      input.rawObjective,
      input.nameHints
    )
    const status: GoalStatus = input.startPaused ? "paused" : "active"
    const row = await createGoal({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      characterId: input.characterId,
      rawObjective: input.rawObjective,
      safeObjective,
      redactionMapEnc,
      status,
      turnsUsed: 0,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config,
      generationId: crypto.randomUUID(),
    })
    await appendGoalEvent({
      goalId: row.id,
      kind: "goal_created",
      payload: { kind: "goal_created", safeObjective, config },
    })
    return row
  }

  /**
   * Replace the active objective. Bumps generationId so any in-flight
   * judge call is ignored. Returns the update message the chat hook
   * should dispatch as the next prompt — or `null` if no active/paused
   * goal exists or the new objective is identical to the current one.
   */
  async updateObjective(
    goalId: string,
    newRawObjective: string,
    nameHints: Iterable<string> = []
  ): Promise<{ goal: Goal; updatePrompt: string } | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (isTerminalGoalStatus(current.status)) return null
    this.fireAbort(goalId)
    const { safeObjective: newSafe, redactionMapEnc } = await redactObjective(
      newRawObjective,
      nameHints
    )
    if (newSafe === current.safeObjective) return null
    const newGen = crypto.randomUUID()
    await updateGoal(goalId, {
      rawObjective: newRawObjective,
      safeObjective: newSafe,
      redactionMapEnc,
      generationId: newGen,
      // Reset judge failure count — old failures shouldn't bleed into the new objective.
      judgeFailureCount: 0,
    })
    await appendGoalEvent({
      goalId,
      kind: "objective_updated",
      payload: {
        kind: "objective_updated",
        oldSafeObjective: current.safeObjective,
        newSafeObjective: newSafe,
      },
    })
    const goal = (await getGoal(goalId)) as Goal
    return {
      goal,
      updatePrompt: renderObjectiveUpdatedMessage(current.safeObjective, newSafe),
    }
  }

  /**
   * Transition an active goal to `paused`. Rotates generationId and fires
   * the abort controller for any in-flight turn driver. No-op when the
   * goal is already paused or terminal.
   */
  async pauseGoal(goalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (current.status !== "active") return current
    this.fireAbort(goalId)
    await updateGoal(goalId, { status: "paused", generationId: crypto.randomUUID() })
    await appendGoalEvent({
      goalId,
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    return (await getGoal(goalId)) ?? null
  }

  /**
   * Transition a paused goal back to `active`. Rotates generationId so a
   * stale in-flight callback (rare) can't write into the resumed
   * generation. No-op when the goal isn't paused.
   */
  async resumeGoal(goalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (current.status !== "paused") return current
    await updateGoal(goalId, { status: "active", generationId: crypto.randomUUID() })
    await appendGoalEvent({
      goalId,
      kind: "user_resumed",
      payload: { kind: "user_resumed" },
    })
    return (await getGoal(goalId)) ?? null
  }

  /**
   * Transition any non-terminal goal to `stopped`. Fires the abort
   * controller. No-op when the goal is already terminal.
   */
  async stopGoal(goalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (isTerminalGoalStatus(current.status)) return current
    this.fireAbort(goalId)
    await updateGoal(goalId, { status: "stopped", generationId: crypto.randomUUID() })
    await appendGoalEvent({
      goalId,
      kind: "user_stopped",
      payload: { kind: "user_stopped" },
    })
    return (await getGoal(goalId)) ?? null
  }

  /**
   * Mark a goal as `preempted` (user sent a fresh non-slash message
   * mid-loop). Same shape as stopGoal but a different reason for the
   * audit trail and UI badge.
   */
  async preemptGoal(goalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (current.status !== "active") return current
    this.fireAbort(goalId)
    await updateGoal(goalId, { status: "preempted", generationId: crypto.randomUUID() })
    await appendGoalEvent({
      goalId,
      kind: "exit_triggered",
      payload: {
        kind: "exit_triggered",
        exit: "preempted",
        reason: "user sent a fresh message while the loop was running",
      },
    })
    return (await getGoal(goalId)) ?? null
  }

  /**
   * Patch an active goal's config mid-flight (e.g. user raised
   * `maxTurns` from the Sheet's Settings tab). Does NOT rotate the
   * generation — config changes don't invalidate in-flight judges.
   */
  async updateConfig(goalId: string, patch: Partial<GoalConfig>): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    if (isTerminalGoalStatus(current.status)) return current
    const before = current.config
    const after: GoalConfig = { ...before, ...patch }
    await updateGoal(goalId, { config: after })
    await appendGoalEvent({
      goalId,
      kind: "config_updated",
      payload: { kind: "config_updated", before, after },
    })
    return (await getGoal(goalId)) ?? null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pass-through readers (provided so call-sites only ever import this module).
  // ───────────────────────────────────────────────────────────────────────────

  getActiveGoalForSession(sessionId: string): Promise<Goal | undefined> {
    return getActiveGoalForSession(sessionId)
  }

  getOpenGoalForSession(sessionId: string): Promise<Goal | undefined> {
    return getOpenGoalForSession(sessionId)
  }

  listGoalsBySession(sessionId: string): Promise<Goal[]> {
    return listGoalsBySession(sessionId)
  }

  /** Delete a goal (and its events). Mostly for History "remove" actions. */
  async deleteGoal(goalId: string): Promise<void> {
    this.fireAbort(goalId)
    await deleteGoal(goalId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor
// ─────────────────────────────────────────────────────────────────────────────

let _instance: GoalRuntime | null = null

export function getGoalRuntime(): GoalRuntime {
  if (!_instance) _instance = new GoalRuntime()
  return _instance
}

/** Test-only escape hatch — wipes registered AbortControllers + singleton state. */
export function __resetGoalRuntimeForTesting(): void {
  _instance = null
}

export type { GoalRuntime }
