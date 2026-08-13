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

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type {
  ContinuationGate,
  Goal,
  GoalConfig,
  GoalCreatedRisk,
  GoalDefaults,
  GoalRunOrigin,
  GoalStatus,
} from "@/types/goal"
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
import { isTauri } from "@/lib/platform/detect"
import { getDb } from "@/lib/db/schema"
import { getActiveLoopForSession } from "@/lib/db/loops"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { adapterAllowsHostCapability } from "@/lib/connectors/permission-resolve"
import { append as appendConnectorAudit } from "@/lib/db/connector-audit"
import { getCharacter } from "@/lib/db/characters"
import { classifyRisk } from "@/lib/policy/risk/classify-risk"
import { requiredCeremony } from "@/lib/policy/risk/ceremony"
import { buildGoalRiskInput } from "./risk-input"
import { redactObjective } from "./redact-objective"
import { decomposeObjective, toSubgoals } from "./subgoals"
import { onGoalTerminal, toGoalHookPayload } from "./completion-linkage"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

/**
 * Thrown by `GoalRuntime.createGoal` when the target session is bound to
 * an IM platform conversation and the matching `ConversationOverrideRow`
 * does not carry `allowGoalDriving === true`. The block is the v49
 * inbox-optimization guardrail: self-driving goals are off by default on
 * IM channels because the loop can auto-reply without operator review.
 *
 * Callers (slash command handler, workflow goal-action node) should
 * surface this to the user — silently swallowing it would hide a refused
 * goal start.
 */
export class GoalImBlocked extends Error {
  readonly conversationKey: string
  readonly adapterId: string
  constructor(conversationKey: string, adapterId: string) {
    super(
      `goal blocked: conversation ${conversationKey} is IM-bound and ConversationOverrideRow.allowGoalDriving is not true`
    )
    this.name = "GoalImBlocked"
    this.conversationKey = conversationKey
    this.adapterId = adapterId
  }
}

/**
 * Thrown by `GoalRuntime.createGoal` when the session already runs an
 * active self-paced `/loop` — both pump the chat hook's turn-complete
 * driver, so running them together would double-dispatch continuations.
 * The mirror check lives in `lib/loop/runtime.ts:createLoop`.
 */
export class GoalLoopConflict extends Error {
  constructor(sessionId: string) {
    super(
      `goal blocked: session ${sessionId} has an active self-paced /loop driving the same turn loop`
    )
    this.name = "GoalLoopConflict"
  }
}
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
  // ADR-0070: risk-driven ceremony is on unless explicitly opted out.
  riskGating: true,
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
    // Optional per-turn USD ceiling — no hard default (undefined ⇒ off).
    maxBudgetUsd: overrides.maxBudgetUsd ?? defaults?.maxBudgetUsd,
    maxJudgeFailures:
      overrides.maxJudgeFailures ??
      defaults?.maxJudgeFailures ??
      DEFAULT_GOAL_CONFIG.maxJudgeFailures,
    timeoutMs: overrides.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs,
    inlineStopCondition: overrides.inlineStopCondition,
    // The acceptance gate had no creation-time passthrough — it was only
    // reachable post-hoc via the settings tab, so `createGoal({ config: {
    // requireAcceptance: true } })` silently dropped it. ADR-0070's raise-only
    // guarantee depends on reading the caller's own choice here, so it is
    // threaded through now. No app-level default: `GoalDefaults` has no mirror.
    requireAcceptance: overrides.requireAcceptance,
    // Risk-driven ceremony (ADR-0070). Default ON — an explicit `false` (per
    // goal or as a settings default) is the only way out.
    riskGating: overrides.riskGating ?? defaults?.riskGating ?? true,
    // Judge customization + pacing — optional, no hard default (undefined ⇒
    // the consumer falls back to its own built-in: chat model / temp 0 /
    // 200 tokens / no delay).
    judgeModel: overrides.judgeModel ?? defaults?.judgeModel,
    judgeProvider: overrides.judgeProvider ?? defaults?.judgeProvider,
    judgePromptOverride: overrides.judgePromptOverride ?? defaults?.judgePromptOverride,
    judgeTemperature: overrides.judgeTemperature ?? defaults?.judgeTemperature,
    judgeMaxTokens: overrides.judgeMaxTokens ?? defaults?.judgeMaxTokens,
    manualContinue: overrides.manualContinue ?? defaults?.manualContinue,
    continuationIntervalMs: overrides.continuationIntervalMs ?? defaults?.continuationIntervalMs,
    quietHours: overrides.quietHours ?? defaults?.quietHours,
    // Completion-promise gate + adaptive pacing. The promise TEXT is
    // per-goal only (a global default token would weaken the gate); the
    // denial cap and the pacing opt-in mirror the other defaults.
    completionPromise: overrides.completionPromise,
    maxPromiseDenials: overrides.maxPromiseDenials ?? defaults?.maxPromiseDenials,
    adaptivePacing: overrides.adaptivePacing ?? defaults?.adaptivePacing,
    verificationWorkflow: overrides.verificationWorkflow,
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
   * Per-goal "advance one turn" listeners (ADR-0019 Phase 2 manual-continue).
   * The chat hook registers a listener while it HOLDs a continuation; the
   * status pill's "Continue" button calls `requestManualContinue` to fire it.
   * Ephemeral renderer state — never persisted (the held message lives in the
   * hook; this only signals "go").
   */
  private manualContinueListeners = new Map<string, Set<() => void>>()

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

  /**
   * Subscribe to manual-continue requests for a goal (ADR-0019 Phase 2). The
   * chat hook calls this while holding a continuation; returns an unsubscribe
   * function. Multiple listeners are supported but the hook registers one at
   * a time and unsubscribes after firing.
   */
  onManualContinue(goalId: string, cb: () => void): () => void {
    let set = this.manualContinueListeners.get(goalId)
    if (!set) {
      set = new Set()
      this.manualContinueListeners.set(goalId, set)
    }
    set.add(cb)
    return () => {
      const s = this.manualContinueListeners.get(goalId)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.manualContinueListeners.delete(goalId)
    }
  }

  /**
   * Fire every manual-continue listener for a goal — called by the status
   * pill's "Continue" button. No-op when nothing is held (the user clicked
   * with no continuation pending).
   */
  requestManualContinue(goalId: string): void {
    const set = this.manualContinueListeners.get(goalId)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb()
      } catch {
        // A listener error must not block the others.
      }
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
  /**
   * Classify a goal and merge the ceremony it owes into its config (ADR-0070
   * Phase 2). Returns the possibly-raised config plus the assessment to record
   * on `goal_created`.
   *
   * Two invariants, both load-bearing:
   *  - **Raise only.** Every merge is `configured || raised`, so a flag the user
   *    set true survives a `low` assessment. The policy adds ceremony; it never
   *    removes any.
   *  - **`manualContinue` is interactive-only.** Holding every turn for a human
   *    who isn't there would park a headless goal forever — a hang, not a gate.
   *    The ceremony map cannot see the origin, so the suppression lives here.
   */
  private async applyGoalRiskGating(params: {
    config: GoalConfig
    safeObjective: string
    characterId?: string
    appSettings: AppSettings | null
    origin: GoalRunOrigin
  }): Promise<{ config: GoalConfig; risk?: GoalCreatedRisk }> {
    const { config, safeObjective, characterId, appSettings, origin } = params
    if (config.riskGating === false) return { config }

    const character = characterId
      ? await getCharacter(characterId).catch(() => undefined)
      : undefined
    const assessment = classifyRisk(buildGoalRiskInput({ safeObjective, character, appSettings }))
    const ceremony = requiredCeremony(assessment)
    if (!ceremony.gate) return { config }

    return {
      config: {
        ...config,
        requireAcceptance: config.requireAcceptance === true || ceremony.requireAcceptance,
        manualContinue:
          config.manualContinue === true || (ceremony.manualContinue && origin === "interactive"),
      },
      risk: {
        tier: assessment.tier,
        surfaces: [...new Set(assessment.surfaces.map((s) => s.id))],
        reason: assessment.reason,
      },
    }
  }

  async createGoal(input: {
    sessionId: string
    characterId?: string
    rawObjective: string
    config?: Partial<GoalConfig>
    nameHints?: Iterable<string>
    appSettings?: AppSettings | null
    startPaused?: boolean
    /**
     * Where this goal is being created from (ADR-0070 Phase 2). Headless
     * origins never get a risk-raised `manualContinue` — nobody is there to
     * click Continue, so the goal would park forever. Defaults to interactive.
     */
    origin?: GoalRunOrigin
  }): Promise<Goal> {
    // ── v49 IM guardrail (inbox-optimization plan) ───────────────────────
    // Self-driving goals must be opted-in per-IM-conversation. If the
    // session is bound to a platform conversation, we read the override
    // row and short-circuit when `allowGoalDriving` is not explicitly
    // true. The block fires a `goal.blocked.im` audit row so the
    // operator can see refused starts in the inbox audit view.
    const session = await getDb().sessions.get(input.sessionId)
    const platformBinding = session?.platformBinding
    if (platformBinding) {
      const [override, adapter] = await Promise.all([
        readForResolution(platformBinding.conversationKey).catch(() => undefined),
        getAdapterInstance(platformBinding.adapterId).catch(() => undefined),
      ])
      const allowed =
        override?.allowGoalDriving === true && adapterAllowsHostCapability(adapter, "goal_driving")
      const auditAt = Date.now()
      if (!allowed) {
        try {
          await appendConnectorAudit({
            adapterId: platformBinding.adapterId,
            kind: "goal.blocked.im",
            at: auditAt,
            conversationKey: platformBinding.conversationKey,
            reason:
              override?.allowGoalDriving === true
                ? "adapter_goal_driving_ceiling"
                : "allow_goal_driving_off",
            message: "GoalRuntime.createGoal blocked — IM conversation not opted in",
            fields: { sessionId: input.sessionId, platform: platformBinding.platform },
          })
        } catch {
          // Best-effort audit — must not block the throw.
        }
        throw new GoalImBlocked(platformBinding.conversationKey, platformBinding.adapterId)
      }
      // Opt-in branch: stamp the start in the inbox audit so operators
      // can see self-driving goals running in IM conversations.
      try {
        await appendConnectorAudit({
          adapterId: platformBinding.adapterId,
          kind: "goal.started.im",
          at: auditAt,
          conversationKey: platformBinding.conversationKey,
          message: "GoalRuntime.createGoal — opt-in granted",
          fields: { sessionId: input.sessionId, platform: platformBinding.platform },
        })
      } catch {
        // Audit failure must not block the goal start.
      }
    }

    // Self-paced /loop exclusivity — both features pump the same
    // turn-complete driver (see GoalLoopConflict docstring).
    const activeLoop = await getActiveLoopForSession(input.sessionId)
    if (activeLoop?.mode === "self_paced") {
      throw new GoalLoopConflict(input.sessionId)
    }

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
    const resolved = resolveGoalConfig(input.appSettings ?? null, input.config ?? {})
    const { safeObjective, redactionMapEnc } = await redactObjective(
      input.rawObjective,
      input.nameHints
    )

    // ── Pre-start risk assessment (ADR-0070 Phase 2) ──────────────────────
    // Classify the redacted objective + the session's configured posture and
    // raise the ceremony this goal owes. Raise-only: a flag the user set
    // explicitly is never cleared here.
    const { config, risk } = await this.applyGoalRiskGating({
      config: resolved,
      safeObjective,
      characterId: input.characterId,
      appSettings: input.appSettings ?? null,
      origin: input.origin ?? "interactive",
    })

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
      payload: { kind: "goal_created", safeObjective, config, ...(risk ? { risk } : {}) },
    })
    void getPluginEventHooks().dispatchGoalCreate(toGoalHookPayload(row))
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
      // Same for the completion-promise gate: a pending verification turn and
      // accumulated denials are meaningless against a different objective.
      awaitingPromise: false,
      promiseDenialCount: 0,
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
    void getPluginEventHooks().dispatchGoalUpdate(toGoalHookPayload(goal))
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
    const updated = (await getGoal(goalId)) ?? null
    void emitGoalStatus(updated)
    return updated
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
    const updated = (await getGoal(goalId)) ?? null
    void emitGoalStatus(updated)
    return updated
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
    const updated = (await getGoal(goalId)) ?? null
    void emitGoalStatus(updated)
    // Completion linkage (ADR-0019 Phase 2) — notify + fire goal-completed
    // workflows on the user-driven terminal transition.
    if (updated) void onGoalTerminal(updated)
    return updated
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
    const updated = (await getGoal(goalId)) ?? null
    void emitGoalStatus(updated)
    if (updated) void onGoalTerminal(updated)
    return updated
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
    const updated = (await getGoal(goalId)) ?? null
    void emitGoalStatus(updated)
    if (updated) void getPluginEventHooks().dispatchGoalUpdate(toGoalHookPayload(updated))
    return updated
  }

  /**
   * Persist the pacing gate's decision so the status pill can render
   * "next continuation at HH:mm" without new subscription plumbing
   * (adaptive pacing): a defer stamps `nextContinuationAt` + source and logs
   * a `pacing_decided` event; a send clears the stamp. Best-effort — pacing
   * bookkeeping must never break the loop itself.
   */
  async recordPacingDecision(
    goalId: string,
    gate: ContinuationGate,
    suggestedMs?: number
  ): Promise<void> {
    try {
      if (gate.kind === "defer") {
        await updateGoal(goalId, {
          nextContinuationAt: gate.untilMs,
          nextContinuationSource: gate.reason,
        })
        await appendGoalEvent({
          goalId,
          kind: "pacing_decided",
          payload: {
            kind: "pacing_decided",
            source: gate.reason,
            untilMs: gate.untilMs,
            ...(typeof suggestedMs === "number" ? { suggestedMs } : {}),
          },
        })
      } else if (gate.kind === "send") {
        await updateGoal(goalId, {
          nextContinuationAt: undefined,
          nextContinuationSource: undefined,
        })
      }
      // hold → nothing to stamp; the pill already shows the Continue button.
    } catch {
      // Best-effort.
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Subgoal decomposition (subgoal decomposition)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run a one-shot decomposition of the goal's objective into a checklist and
   * persist it (replacing any prior checklist). Returns the updated goal, or
   * `null` if the goal is missing. When decomposition fails OPEN (empty list),
   * the existing checklist is left untouched and `null`-ish progress is
   * surfaced to the caller via an unchanged `subgoals` (so the UI shows an
   * error/empty state without wiping prior work).
   */
  async generateSubgoals(goalId: string, client: LlmClient): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    const steps = await decomposeObjective({ goal: current, client })
    if (steps.length === 0) {
      // Fail-OPEN: keep whatever was there; signal "no change" to the caller.
      return current
    }
    const subgoals = toSubgoals(steps)
    await updateGoal(goalId, { subgoals, subgoalsGeneratedAt: Date.now() })
    await appendGoalEvent({
      goalId,
      kind: "subgoals_generated",
      payload: { kind: "subgoals_generated", count: subgoals.length },
    })
    const updated = (await getGoal(goalId)) ?? null
    if (updated) void getPluginEventHooks().dispatchGoalUpdate(toGoalHookPayload(updated))
    return updated
  }

  /** Flip a single subgoal's `done` flag. No-op when goal/subgoal is missing. */
  async toggleSubgoal(goalId: string, subgoalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current?.subgoals) return current ?? null
    let changed = false
    const next = current.subgoals.map((s) => {
      if (s.id === subgoalId) {
        changed = true
        return { ...s, done: !s.done }
      }
      return s
    })
    if (!changed) return current
    await updateGoal(goalId, { subgoals: next })
    return (await getGoal(goalId)) ?? null
  }

  /** Drop the goal's checklist entirely. */
  async clearSubgoals(goalId: string): Promise<Goal | null> {
    const current = await getGoal(goalId)
    if (!current) return null
    await updateGoal(goalId, { subgoals: [], subgoalsGeneratedAt: undefined })
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
    this.manualContinueListeners.delete(goalId)
    await deleteGoal(goalId)
    void getPluginEventHooks().dispatchGoalDelete(goalId)
  }
}

/**
 * Broadcast a goal status snapshot to companion WebSocket subscribers
 * (mobile) as a `goal://status` Tauri event so a remote watcher sees
 * pause / resume / stop transitions live. Mirrors `emitMessageEvent` in
 * `lib/db/plugin-bridge.ts`: lazy Tauri import so the web build stays
 * decoupled; failures are swallowed (the Dexie write already succeeded).
 */
async function emitGoalStatus(goal: Goal | null): Promise<void> {
  if (!goal) return
  if (!isTauri()) return
  try {
    const moduleId = "@tauri-apps/api/event"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (event: string, payload: unknown) => Promise<void>
    }
    await mod.emit("goal://status", {
      goalId: goal.id,
      sessionId: goal.sessionId,
      status: goal.status,
    })
  } catch {
    // Tauri unavailable or transport hiccup — best effort.
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
