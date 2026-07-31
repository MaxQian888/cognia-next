/**
 * `/loop` Command — type model.
 *
 * A loop repeatedly re-runs a prompt (or a slash command) in a chat session.
 * Two execution modes share one persistence model (Dexie v79: `loops` +
 * `loopEvents`):
 *
 *   • `interval`    — fixed cadence. Backed by a session-scoped scheduler
 *                     task of the existing `"chat"` type, which contributes
 *                     overlap policies / jitter / the Rust alarm daemon for
 *                     free. The loop row stores the `scheduledTaskId` and
 *                     mirrors lifecycle into the scheduler.
 *   • `self_paced`  — turn-driven, modeled on the `/goal` loop: after each
 *                     iteration the model reports a suggested next delay +
 *                     reason (bounded 1 min – 1 hr) and may end the loop by
 *                     declaring completion.
 *
 * Lifecycle mirrors `types/goal.ts`: `active` is the only pumpable status,
 * `paused` is resumable, everything else is terminal. `generationId` is the
 * same race guard — every status mutation rotates it, and the self-paced
 * turn driver refuses to act on a stale generation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Loop
// ─────────────────────────────────────────────────────────────────────────────

export type LoopMode = "interval" | "self_paced"

/**
 * Status state machine.
 *
 *   active             → looping
 *   paused             → resumable; nothing fires
 *   completed          → self-paced model declared completion (terminal)
 *   stopped            → user `/loop stop` (terminal)
 *   iteration_limited  → iterations >= maxIterations (terminal)
 *   budget_limited     → tokensUsed >= maxTokens (terminal)
 *   expired            → wall-clock passed expiresAt (terminal)
 *   error              → repeated trailer parse failures (terminal)
 */
export type LoopStatus =
  | "active"
  | "paused"
  | "completed"
  | "stopped"
  | "iteration_limited"
  | "budget_limited"
  | "expired"
  | "error"

/** True when the status is terminal (cannot transition out). */
export function isTerminalLoopStatus(status: LoopStatus): boolean {
  return status !== "active" && status !== "paused"
}

/** Per-loop knobs — defaults come from `AppSettings.loops` via `resolveLoopConfig`. */
export interface LoopConfig {
  /** Hard cap on iterations. Default 100. */
  maxIterations: number
  /** Hard cap on cumulative tokens (self-paced only; interval iterations bill the session). Default 1_000_000. */
  maxTokens: number
  /** Self-paced delay floor (ms). Default 60_000. */
  minDelayMs: number
  /** Self-paced delay ceiling (ms). Default 3_600_000. */
  maxDelayMs: number
  /**
   * Consecutive `<next-loop/>` trailer parse failures before the loop exits
   * with `error` (fail-OPEN: single failures continue at minDelay). Default 3.
   */
  maxParseFailures: number
}

export interface Loop {
  /** UUIDv4. */
  id: string
  /** FK → ChatSession.id. Session-scoped: at most one active loop per session. */
  sessionId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86); inherits the session's project. */
  projectId?: string
  mode: LoopMode
  /**
   * User's original prompt text, preserved verbatim for the UI. NEVER
   * concatenated into a prompt — `safePrompt` is what reaches the LLM.
   */
  rawPrompt: string
  /** PII-redacted prompt (same gate as `/goal`: `lib/goal/redact-objective.ts`). */
  safePrompt: string
  /** Encrypted PII↔placeholder map; empty string when no PII was found. */
  redactionMapEnc: string
  /** True when the prompt is a slash command re-dispatched each iteration. */
  isSlashCommand: boolean
  /** The bare command name (no slash) when `isSlashCommand`. */
  commandName?: string
  status: LoopStatus
  /** Completed iterations so far. */
  iterations: number
  /** Cumulative tokens billed against this loop (self-paced). */
  tokensUsed: number
  /** Race guard — rotates on every status mutation (see module docstring). */
  generationId: string
  config: LoopConfig
  createdAt: number
  updatedAt: number
  /** Set when status becomes terminal. */
  endedAt?: number

  // ── interval mode ─────────────────────────────────────────────────────────
  /** Backing scheduler task id (`type: "chat"`, `tags: ["loop"]`). */
  scheduledTaskId?: string
  /** Fixed cadence in ms. */
  intervalMs?: number
  /** Hard expiry (creation + 7 days) — a forgotten loop can't run forever. */
  expiresAt?: number

  // ── self-paced mode ───────────────────────────────────────────────────────
  /** Model-chosen delay before the next iteration (clamped). */
  nextDelayMs?: number
  /** Model's stated reason for the delay (shown in the pill + activity log). */
  nextDelayReason?: string
  /** Epoch ms of the last completed iteration. */
  lastIterationAt?: number
  /** Consecutive trailer parse failures (resets on success). */
  parseFailureCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// LoopEvent — append-only lifecycle log
// ─────────────────────────────────────────────────────────────────────────────

export type LoopEventKind =
  | "loop_created"
  | "iteration_started"
  | "iteration_completed"
  | "delay_decided"
  | "delay_parse_failed"
  | "exit_triggered"
  | "user_paused"
  | "user_resumed"
  | "user_stopped"
  | "config_updated"
  | "interval_fired"

export type LoopEventPayload =
  | { kind: "loop_created"; mode: LoopMode; safePrompt: string; config: LoopConfig }
  | { kind: "iteration_started"; iteration: number }
  | { kind: "iteration_completed"; iteration: number; tokensDelta: number }
  | { kind: "delay_decided"; delayMs: number; reason?: string }
  | { kind: "delay_parse_failed"; failureCount: number }
  | { kind: "exit_triggered"; exit: LoopExitReason; reason: string }
  | { kind: "user_paused" }
  | { kind: "user_resumed" }
  | { kind: "user_stopped" }
  | { kind: "config_updated"; before: LoopConfig; after: LoopConfig }
  | { kind: "interval_fired"; iteration: number }

export interface LoopEvent {
  /** UUIDv4 primary key. */
  id: string
  /** FK → Loop.id. Cascade-delete at the CRUD layer (lib/db/loops.ts). */
  loopId: string
  kind: LoopEventKind
  ts: number
  payload: LoopEventPayload
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit reasons
// ─────────────────────────────────────────────────────────────────────────────

export type LoopExitReason =
  | "user_stopped"
  | "iteration_limited"
  | "budget_limited"
  | "expired"
  | "completed"
  | "parse_failed_too_many"

/** Maps an exit reason to the terminal status the loop should land in. */
export function statusForLoopExit(exit: LoopExitReason): LoopStatus {
  switch (exit) {
    case "user_stopped":
      return "stopped"
    case "iteration_limited":
      return "iteration_limited"
    case "budget_limited":
      return "budget_limited"
    case "expired":
      return "expired"
    case "completed":
      return "completed"
    case "parse_failed_too_many":
      return "error"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AppSettings extension — global defaults set in Settings.
// ─────────────────────────────────────────────────────────────────────────────

/** Optional `AppSettings.loops` block — defaults applied to fresh loops. */
export interface LoopDefaults {
  maxIterations?: number
  maxTokens?: number
  minDelayMs?: number
  maxDelayMs?: number
  maxParseFailures?: number
}
