/**
 * `/goal` Command — type model. (ADR-0013)
 *
 * Two Dexie tables back the subsystem (see `lib/db/schema.ts` v30):
 *
 *   • `chatGoals`       — one row per goal; session-scoped (one active goal
 *                         per session at a time, terminal goals stick around
 *                         for the History view).
 *   • `chatGoalEvents`  — one row per lifecycle event (created / turn /
 *                         judge / exit / user_action). Drives the Activity
 *                         tab and the audit trail.
 *
 * Lifecycle: `active` is the only non-terminal status that the turn driver
 * can pump. `paused` can be resumed back to `active`. Everything else is
 * terminal — never returns to `active`.
 *
 * The `generationId` field is the race guard: every status mutation rotates
 * it, and `turn-driver.ts` checks the captured generation before scheduling
 * the next continuation. A user `/goal pause` / `/goal stop` / `/goal
 * update` mid-turn → bumped generation → in-flight judge result is
 * silently dropped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Goal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status state machine. Order in this union is also the priority order used
 * by `lib/goal/exit-conditions.ts:evaluateExitConditions`.
 *
 *   active           → driving forward
 *   paused           → resumable; turn driver yields
 *   completed        → judge said done=true (terminal)
 *   stopped          → user `/goal stop|cancel|clear` (terminal)
 *   budget_limited   → tokensUsed >= maxTokens (terminal)
 *   turn_limited     → turnsUsed >= maxTurns (terminal)
 *   timed_out        → wall-clock exceeded timeoutMs (terminal)
 *   preempted        → user typed a non-slash message mid-loop (terminal)
 */
export type GoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "stopped"
  | "budget_limited"
  | "turn_limited"
  | "timed_out"
  | "preempted"

/** True when the status is terminal (cannot transition out). */
export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return (
    status === "completed" ||
    status === "stopped" ||
    status === "budget_limited" ||
    status === "turn_limited" ||
    status === "timed_out" ||
    status === "preempted"
  )
}

/** Per-goal knobs — defaults come from `AppSettings.goals` via `lib/goal/runtime.ts:resolveDefaults`. */
export interface GoalConfig {
  /** Hard cap on completed turns. Default 20 (Hermes default). Range 1..100. */
  maxTurns: number
  /** Hard cap on cumulative tokens (input + output). Default 200_000. */
  maxTokens: number
  /**
   * Consecutive judge JSON parse failures before the goal auto-pauses
   * (fail-OPEN: never wedge on judge flakiness). Default 3 (Hermes default).
   */
  maxJudgeFailures: number
  /** Wall-clock timeout in ms. Default 30 * 60_000 (30 min). */
  timeoutMs: number
  /**
   * User-supplied "or stop after N turns" condition appended to the system
   * prompt verbatim. Claude Code-style escape hatch when the model's own
   * judgment of "done" feels unreliable for the task.
   */
  inlineStopCondition?: string
}

export interface Goal {
  /** UUIDv4. Globally unique; safe to use as a Dexie primary key. */
  id: string
  /** FK → ChatSession.id. Session-scoped: at most one row with status==="active" per sessionId. */
  sessionId: string
  /**
   * Snapshot of the character at goal creation time. UI only — used by the
   * Activity tab to render the right avatar even after the user switches
   * the session's character.
   */
  characterId?: string
  /**
   * User's original objective text, preserved verbatim for the UI to
   * display ("show me what I asked for"). NEVER concatenated into a prompt
   * directly — `safeObjective` is what reaches the LLM.
   */
  rawObjective: string
  /**
   * PII-redacted objective. Goes into `<objective>` XML tag in the system
   * prompt and into judge prompts. Built by `lib/goal/redact-objective.ts`.
   */
  safeObjective: string
  /**
   * Encrypted PII↔placeholder map (base64 ciphertext + nonce + tag).
   * Tauri: encrypted with the keyring-derived data key. Web: AES-GCM with a
   * key derived from `AppSettings.id` (best-effort; the web build flags this
   * as a degraded mode in the docs). Empty string when no PII was found.
   */
  redactionMapEnc: string
  status: GoalStatus
  /** Number of model turns completed against this goal so far. */
  turnsUsed: number
  /** Cumulative input + output tokens billed against this goal. */
  tokensUsed: number
  /**
   * Consecutive judge parse failures since the last successful judge call.
   * Resets to 0 on success. When ≥ `config.maxJudgeFailures` the
   * `judge_failed_too_many` exit fires.
   */
  judgeFailureCount: number
  config: GoalConfig
  /**
   * Race guard. Every status mutation rotates this string (UUIDv4). The turn
   * driver captures the generationId at evaluation start and refuses to
   * schedule the next continuation if it changed.
   */
  generationId: string
  createdAt: number
  updatedAt: number
  /** Set when status becomes terminal. Drives History sorting + reset countdown. */
  endedAt?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// GoalEvent — append-only lifecycle log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminator for `GoalEvent.payload` shape. Each kind has a payload
 * declared inline below; the union here drives `chatGoalEvents` index lookups
 * (filter by kind in the Activity tab).
 */
export type GoalEventKind =
  | "goal_created"
  | "objective_updated"
  | "turn_started"
  | "turn_completed"
  | "judge_evaluated"
  | "judge_parse_failed"
  | "exit_triggered"
  | "user_paused"
  | "user_resumed"
  | "user_stopped"
  | "config_updated"

/**
 * Per-kind payloads. Keep these structurally typed (TypeScript discriminated
 * union via `kind`) — it lets the Activity tab render kind-specific cards
 * without runtime checks beyond the discriminator.
 */
export type GoalEventPayload =
  | { kind: "goal_created"; safeObjective: string; config: GoalConfig }
  | { kind: "objective_updated"; oldSafeObjective: string; newSafeObjective: string }
  | { kind: "turn_started"; turnNumber: number }
  | {
      kind: "turn_completed"
      turnNumber: number
      tokensDelta: number
      modelMessageId?: string
    }
  | {
      kind: "judge_evaluated"
      done: boolean
      reason: string
      judgeTokens: number
    }
  | { kind: "judge_parse_failed"; raw: string; failureCount: number }
  | { kind: "exit_triggered"; exit: ExitReason; reason: string }
  | { kind: "user_paused" }
  | { kind: "user_resumed" }
  | { kind: "user_stopped" }
  | { kind: "config_updated"; before: GoalConfig; after: GoalConfig }

export interface GoalEvent {
  /** UUIDv4 primary key. */
  id: string
  /** FK → Goal.id. Cascade-delete is performed at the CRUD layer (lib/db/goals.ts). */
  goalId: string
  kind: GoalEventKind
  ts: number
  payload: GoalEventPayload
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit reasons — discriminated union returned by `evaluateExitConditions`.
// ─────────────────────────────────────────────────────────────────────────────

export type ExitReason =
  | "user_stopped"
  | "preempted"
  | "turn_limited"
  | "budget_limited"
  | "timed_out"
  | "judge_failed_too_many"
  | "judge_done"

/**
 * Maps an exit reason to the terminal/paused status the goal should land in.
 * Two non-terminal exits use `paused` so the user can manually resume.
 */
export function statusForExit(exit: ExitReason): GoalStatus {
  switch (exit) {
    case "user_stopped":
      return "stopped"
    case "preempted":
      return "preempted"
    case "turn_limited":
      return "turn_limited"
    case "budget_limited":
      return "budget_limited"
    case "timed_out":
      return "timed_out"
    case "judge_failed_too_many":
      return "paused"
    case "judge_done":
      return "completed"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AppSettings extension — global defaults set in Settings → Goals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional `AppSettings.goals` block holding the defaults the runtime applies
 * when creating a fresh Goal. Absent → falls back to the hard-coded defaults
 * in `lib/goal/runtime.ts:DEFAULT_GOAL_CONFIG`.
 */
export interface GoalDefaults {
  maxTurns?: number
  maxTokens?: number
  maxJudgeFailures?: number
  timeoutMs?: number
  /** When true, every new goal is created paused (user must `/goal resume` to start). */
  startPaused?: boolean
  /**
   * When true, the composer pill is shown but the auto-continuation message
   * is NOT dispatched — the user must hit a "Continue" button per turn.
   * Phase 1 ships this off by default; reserved for users who want a manual
   * loop without losing the persistent objective.
   */
  manualContinue?: boolean
}
