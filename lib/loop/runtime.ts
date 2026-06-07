/**
 * LoopRuntime — the renderer-side singleton that owns `/loop` lifecycle.
 *
 * Mirrors `lib/goal/runtime.ts`:
 *  - `createLoop()`  — redact (reuses the goal redaction gate), persist,
 *                      log `loop_created`; interval mode also creates the
 *                      backing scheduler task and stores its id.
 *  - `pauseLoop()` / `resumeLoop()` / `stopLoop()` — status transitions
 *                      with generationId rotation + AbortController fan-out;
 *                      interval mode mirrors into the scheduler task.
 *  - `registerAbortController(loopId, ac)` — the turn driver registers its
 *                      signal so pause/stop can interrupt mid-iteration.
 *
 * **Goal exclusivity:** a self-paced loop and a self-driving goal both pump
 * the chat hook's turn-complete driver — running both in one session would
 * double-dispatch. `createLoop` refuses (throws `LoopGoalConflict`) when an
 * active goal exists; `GoalRuntime.createGoal` carries the symmetric check.
 * Interval loops fire through the scheduler queue and are NOT exclusive.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { Loop, LoopConfig, LoopDefaults, LoopStatus } from "@/types/loop"
import { isTerminalLoopStatus } from "@/types/loop"
import {
  appendLoopEvent,
  createLoop,
  deleteLoop,
  getActiveLoopForSession,
  getLoop,
  getOpenLoopForSession,
  listLoopsBySession,
  updateLoop,
} from "@/lib/db/loops"
import { redactObjective } from "@/lib/goal/redact-objective"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { buildLoopTaskInput, LOOP_EXPIRY_MS } from "./interval"

/**
 * Thrown by `createLoop` when the session already runs an active goal and
 * the requested loop is self-paced (both pump the same turn driver).
 * Callers surface this to the user — swallowing it would hide the refusal.
 */
export class LoopGoalConflict extends Error {
  constructor(sessionId: string) {
    super(`loop blocked: session ${sessionId} has an active goal driving the same turn loop`)
    this.name = "LoopGoalConflict"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 100,
  maxTokens: 1_000_000,
  minDelayMs: 60_000,
  maxDelayMs: 3_600_000,
  maxParseFailures: 3,
}

/** Resolve the effective per-loop config from a settings snapshot. */
export function resolveLoopConfig(
  appSettings: AppSettings | null | undefined,
  overrides: Partial<LoopConfig> = {}
): LoopConfig {
  const defaults = (appSettings as { loops?: LoopDefaults } | null | undefined)?.loops
  return {
    maxIterations:
      overrides.maxIterations ?? defaults?.maxIterations ?? DEFAULT_LOOP_CONFIG.maxIterations,
    maxTokens: overrides.maxTokens ?? defaults?.maxTokens ?? DEFAULT_LOOP_CONFIG.maxTokens,
    minDelayMs: overrides.minDelayMs ?? defaults?.minDelayMs ?? DEFAULT_LOOP_CONFIG.minDelayMs,
    maxDelayMs: overrides.maxDelayMs ?? defaults?.maxDelayMs ?? DEFAULT_LOOP_CONFIG.maxDelayMs,
    maxParseFailures:
      overrides.maxParseFailures ??
      defaults?.maxParseFailures ??
      DEFAULT_LOOP_CONFIG.maxParseFailures,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

interface AbortRegistration {
  loopId: string
  controller: AbortController
}

class LoopRuntime {
  /** Per-loop active turn-driver abort controllers. */
  private aborters = new Map<string, AbortRegistration>()

  /**
   * Self-paced kick-off listeners. The chat hook subscribes once at mount;
   * `createLoop` / `resumeLoop` fire so iteration 1 (or the resumed
   * iteration) dispatches through the hook's SILENT send path — the same
   * path as every later continuation, and one that bypasses the
   * fresh-user-message preempt that would otherwise pause the new loop.
   * Ephemeral renderer state, never persisted.
   */
  private kickoffListeners = new Set<(loop: Loop) => void>()

  /** Subscribe to self-paced kick-off requests. Returns an unsubscribe fn. */
  onKickoff(cb: (loop: Loop) => void): () => void {
    this.kickoffListeners.add(cb)
    return () => {
      this.kickoffListeners.delete(cb)
    }
  }

  private fireKickoff(loop: Loop): void {
    for (const cb of [...this.kickoffListeners]) {
      try {
        cb(loop)
      } catch {
        // A listener error must not block the others.
      }
    }
  }

  registerAbortController(loopId: string, controller: AbortController): () => void {
    this.aborters.set(loopId, { loopId, controller })
    return () => {
      const existing = this.aborters.get(loopId)
      if (existing?.controller === controller) {
        this.aborters.delete(loopId)
      }
    }
  }

  private fireAbort(loopId: string): void {
    const reg = this.aborters.get(loopId)
    if (!reg) return
    this.aborters.delete(loopId)
    if (!reg.controller.signal.aborted) {
      reg.controller.abort()
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a fresh loop for a session. An existing open loop is stopped
   * first (session-scoped uniqueness); a self-paced request against a
   * session with an active goal throws `LoopGoalConflict`.
   */
  async createLoop(input: {
    sessionId: string
    rawPrompt: string
    mode: Loop["mode"]
    /** Required for interval mode. */
    intervalMs?: number
    config?: Partial<LoopConfig>
    nameHints?: Iterable<string>
    appSettings?: AppSettings | null
  }): Promise<Loop> {
    if (input.mode === "self_paced") {
      const goal = await getGoalRuntime().getActiveGoalForSession(input.sessionId)
      if (goal) throw new LoopGoalConflict(input.sessionId)
    }

    const existing = await getOpenLoopForSession(input.sessionId)
    if (existing) {
      await this.stopLoop(existing.id)
    }

    const config = resolveLoopConfig(input.appSettings ?? null, input.config ?? {})
    const { safeObjective: safePrompt, redactionMapEnc } = await redactObjective(
      input.rawPrompt,
      input.nameHints ?? []
    )
    const trimmed = input.rawPrompt.trim()
    const isSlashCommand = trimmed.startsWith("/")
    const commandName = isSlashCommand ? trimmed.slice(1).split(/\s+/)[0] : undefined
    const now = Date.now()
    const row = await createLoop({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      mode: input.mode,
      rawPrompt: input.rawPrompt,
      safePrompt,
      redactionMapEnc,
      isSlashCommand,
      commandName,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: crypto.randomUUID(),
      config,
      parseFailureCount: 0,
      intervalMs: input.mode === "interval" ? input.intervalMs : undefined,
      expiresAt: now + LOOP_EXPIRY_MS,
    })
    await appendLoopEvent({
      loopId: row.id,
      kind: "loop_created",
      payload: { kind: "loop_created", mode: row.mode, safePrompt, config },
    })

    if (input.mode === "interval") {
      // The scheduler task is the actual timing engine; the loop row links
      // to it so pause/resume/stop mirror both ways. Creation failure rolls
      // the loop back instead of leaving a dead row.
      try {
        const task = await getTaskScheduler().createTask(buildLoopTaskInput(row))
        await updateLoop(row.id, { scheduledTaskId: task.id })
      } catch (err) {
        await deleteLoop(row.id)
        throw err
      }
      return (await getLoop(row.id)) as Loop
    }
    // Self-paced: ask the chat hook to dispatch iteration 1.
    this.fireKickoff(row)
    return row
  }

  /** Active → paused. Rotates generation, aborts in-flight work, mirrors the scheduler task. */
  async pauseLoop(loopId: string): Promise<Loop | null> {
    const current = await getLoop(loopId)
    if (!current) return null
    if (current.status !== "active") return current
    this.fireAbort(loopId)
    await updateLoop(loopId, { status: "paused", generationId: crypto.randomUUID() })
    await appendLoopEvent({ loopId, kind: "user_paused", payload: { kind: "user_paused" } })
    if (current.scheduledTaskId) {
      await getTaskScheduler()
        .pauseTask(current.scheduledTaskId)
        .catch(() => {})
    }
    return (await getLoop(loopId)) ?? null
  }

  /** Paused → active. Self-paced loops get a kick-off (no scheduler tick). */
  async resumeLoop(loopId: string): Promise<Loop | null> {
    const current = await getLoop(loopId)
    if (!current) return null
    if (current.status !== "paused") return current
    await updateLoop(loopId, { status: "active", generationId: crypto.randomUUID() })
    await appendLoopEvent({ loopId, kind: "user_resumed", payload: { kind: "user_resumed" } })
    if (current.scheduledTaskId) {
      await getTaskScheduler()
        .resumeTask(current.scheduledTaskId)
        .catch(() => {})
    }
    const updated = (await getLoop(loopId)) ?? null
    if (updated && updated.mode === "self_paced") {
      this.fireKickoff(updated)
    }
    return updated
  }

  /** Any non-terminal → stopped. Deletes the backing scheduler task. */
  async stopLoop(loopId: string): Promise<Loop | null> {
    const current = await getLoop(loopId)
    if (!current) return null
    if (isTerminalLoopStatus(current.status)) return current
    this.fireAbort(loopId)
    await updateLoop(loopId, { status: "stopped", generationId: crypto.randomUUID() })
    await appendLoopEvent({ loopId, kind: "user_stopped", payload: { kind: "user_stopped" } })
    if (current.scheduledTaskId) {
      await getTaskScheduler()
        .deleteTask(current.scheduledTaskId)
        .catch(() => {})
    }
    return (await getLoop(loopId)) ?? null
  }

  /** Patch config mid-flight (no generation rotation). */
  async updateConfig(loopId: string, patch: Partial<LoopConfig>): Promise<Loop | null> {
    const current = await getLoop(loopId)
    if (!current) return null
    if (isTerminalLoopStatus(current.status)) return current
    const before = current.config
    const after: LoopConfig = { ...before, ...patch }
    await updateLoop(loopId, { config: after })
    await appendLoopEvent({
      loopId,
      kind: "config_updated",
      payload: { kind: "config_updated", before, after },
    })
    return (await getLoop(loopId)) ?? null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pass-through readers
  // ───────────────────────────────────────────────────────────────────────────

  getActiveLoopForSession(sessionId: string): Promise<Loop | undefined> {
    return getActiveLoopForSession(sessionId)
  }

  getOpenLoopForSession(sessionId: string): Promise<Loop | undefined> {
    return getOpenLoopForSession(sessionId)
  }

  listLoopsBySession(sessionId: string): Promise<Loop[]> {
    return listLoopsBySession(sessionId)
  }

  /** Delete a loop (and its events + backing scheduler task). */
  async deleteLoop(loopId: string): Promise<void> {
    const current = await getLoop(loopId)
    this.fireAbort(loopId)
    if (current?.scheduledTaskId) {
      await getTaskScheduler()
        .deleteTask(current.scheduledTaskId)
        .catch(() => {})
    }
    await deleteLoop(loopId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor
// ─────────────────────────────────────────────────────────────────────────────

let _instance: LoopRuntime | null = null

export function getLoopRuntime(): LoopRuntime {
  if (!_instance) _instance = new LoopRuntime()
  return _instance
}

/** Test-only escape hatch. */
export function __resetLoopRuntimeForTesting(): void {
  _instance = null
}

export type { LoopRuntime }
export type { LoopStatus }
