/**
 * Long-step runner — a helper that lets a workflow step run for many
 * minutes (Claude Code subprocess, AI-driven code-review pass, …) and
 * still survive a process crash. The runner writes incremental
 * checkpoints into the durable event log; on resume, the latest
 * checkpoint is replayed into the step's `onResume` so the work picks up
 * roughly where it stopped instead of starting over.
 *
 * Design constraints that fall out of cognia's existing primitives:
 *
 * - Checkpoint storage piggy-backs on `workflowRunEvents` so the editor,
 *   the Runs UI, and the orchestrator's idempotency cache already
 *   subscribe to it. No new Dexie table.
 * - The `step_completed` event is written only at the very end by the
 *   step executor, NOT by this helper. Until then, the step is "not
 *   done" from the orchestrator's perspective and will be re-entered on
 *   resume.
 * - The resumer registry is a plain `Map<string, Resumer>` keyed by an
 *   opaque string (typically `step.kind` or a plugin-defined token). The
 *   driver picks the key when it calls `runLongStep` and exposes the
 *   matching `Resumer` to `registerLongStepResumer` at activation time.
 *
 * This module is deliberately runtime-agnostic — it knows nothing about
 * Claude, GitHub, or any plugin. It just shuttles state through the
 * event log and re-invokes a caller-supplied `run` function.
 */

import { listRunEvents, appendEvent } from "./event-log"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

export interface LongStepProgressEvent {
  message: string
  data?: unknown
  ts: number
}

export interface LongStepCtx<S> {
  /** Latest state value — initial on fresh starts, restored on resume. */
  state: S
  /** Persist a new state value. Returns once the row is durable. */
  checkpoint(next: S): Promise<void>
  /** Emit a human-readable progress message (also lands in the event log). */
  progress(message: string, data?: unknown): Promise<void>
  /** Mirrors the surrounding step's abort signal. */
  signal: AbortSignal
}

export interface LongStepOptions<T, S> {
  runId: string
  stepId: string
  /**
   * Per-step bucket within (runId, stepId). Two long-running phases inside
   * one step can use different keys (e.g., "clone" vs "ai-run") without
   * trampling each other's checkpoints.
   */
  checkpointKey: string
  initialState: S
  /** The actual long-running work. Receives a `LongStepCtx`. */
  run: (ctx: LongStepCtx<S>) => Promise<T>
  /**
   * Restore handler called by `resumeLongStep` AFTER the latest checkpoint
   * is read but BEFORE `run` re-executes. Return the (possibly massaged)
   * state to pass back into the next `run` invocation, or `false` to
   * abandon the resume (the surrounding step will then fail and the
   * orchestrator decides whether to retry per its policy).
   */
  onResume?: (state: S) => Promise<S | false>
  /** Optional caller-provided abort signal (defaults to a fresh controller). */
  signal?: AbortSignal
}

export interface LongStepHandle<T> {
  promise: Promise<T>
  abort(reason?: string): void
  onProgress(cb: (e: LongStepProgressEvent) => void): () => void
}

/**
 * The resumer is invoked by `resume-controller` when an in-flight step has
 * a `step.long_running.checkpoint` event but no `step_completed`. Implementers
 * (typically plugin activate functions) hand back a Promise that completes
 * with the step's terminal output, exactly as a fresh `runLongStep` would.
 */
export type Resumer = (input: {
  runId: string
  stepId: string
  checkpointKey: string
  state: unknown
}) => Promise<unknown>

const resumers = new Map<string, Resumer>()

/**
 * Register a resumer keyed by an opaque token. Plugin activate functions
 * call this so `resume-controller` can find the right callback after a
 * restart. Returns an unregister function.
 */
export function registerLongStepResumer(key: string, resumer: Resumer): () => void {
  resumers.set(key, resumer)
  return () => {
    if (resumers.get(key) === resumer) resumers.delete(key)
  }
}

export function getLongStepResumer(key: string): Resumer | undefined {
  return resumers.get(key)
}

/** Test utility — drops every registered resumer. */
export function __resetResumersForTesting(): void {
  resumers.clear()
}

/**
 * Run a long step. The returned handle exposes both the underlying
 * promise and an `abort` shortcut so callers can wire it to the
 * surrounding step's abort signal.
 */
export function runLongStep<T, S>(opts: LongStepOptions<T, S>): LongStepHandle<T> {
  const controller = new AbortController()
  // Wire the caller's signal through so external aborts propagate.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason)
    else
      opts.signal.addEventListener("abort", () => controller.abort(opts.signal?.reason), {
        once: true,
      })
  }
  const listeners = new Set<(e: LongStepProgressEvent) => void>()

  const ctx: LongStepCtx<S> = {
    state: opts.initialState,
    async checkpoint(next: S): Promise<void> {
      ctx.state = next
      // Best-effort persistence — losing a checkpoint shouldn't crash the
      // run (callers care more about completing the work than about future
      // resumability). Dexie failures (no IndexedDB / closed db / etc.)
      // surface in the log and proceed.
      try {
        await appendEvent({
          runId: opts.runId,
          stepId: opts.stepId,
          type: "step.long_running.checkpoint",
          payload: { checkpointKey: opts.checkpointKey, state: next },
        })
      } catch (err) {
        console.warn("runLongStep: checkpoint persistence failed", err)
      }
    },
    async progress(message: string, data?: unknown): Promise<void> {
      const ts = Date.now()
      const evt: LongStepProgressEvent = { message, data, ts }
      for (const cb of listeners) {
        try {
          cb(evt)
        } catch {
          /* never let a listener kill the run */
        }
      }
      try {
        await appendEvent({
          runId: opts.runId,
          stepId: opts.stepId,
          type: "step.long_running.progress",
          payload: { checkpointKey: opts.checkpointKey, message, data },
        })
      } catch (err) {
        console.warn("runLongStep: progress persistence failed", err)
      }
    },
    signal: controller.signal,
  }

  // Defer the run start by one microtask so callers have a chance to wire
  // up `onProgress` before the first `ctx.progress(...)` fires. Before
  // invoking `opts.run`, check the event log for a previous checkpoint —
  // if one exists, hand it to `onResume` so the run picks up from where
  // it crashed instead of starting over. Like the writes above, the read
  // is best-effort: a missing event log means we start fresh.
  const promise = Promise.resolve().then(async () => {
    if (opts.onResume) {
      let events: WorkflowRunEventRow[] = []
      try {
        events = await listRunEvents(opts.runId)
      } catch (err) {
        console.warn("runLongStep: resume lookup failed; starting fresh", err)
        events = []
      }
      const latest = findLatestCheckpoint(events, opts.stepId)
      if (latest && latest.checkpointKey === opts.checkpointKey) {
        const restored = await opts.onResume(latest.state as S)
        if (restored === false) {
          throw new Error(`runLongStep: onResume abandoned the prior checkpoint for ${opts.stepId}`)
        }
        ctx.state = restored
      }
    }
    return opts.run(ctx)
  })

  return {
    promise,
    abort(reason?: string) {
      controller.abort(reason)
    },
    onProgress(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/**
 * Resume a long step from its latest checkpoint. Called by the
 * resume-controller on app start when it finds a `step.long_running.*`
 * event for a step that has no `step_completed`.
 *
 * Returns `null` when no checkpoint exists (the step never wrote one
 * before crashing) — the caller can then start the step from scratch
 * via its normal entry path.
 */
export async function resumeLongStep(
  runId: string,
  stepId: string,
  resumerKey: string
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string } | null> {
  const resumer = resumers.get(resumerKey)
  if (!resumer) {
    return { ok: false, reason: `no resumer registered for key '${resumerKey}'` }
  }
  const events = await listRunEvents(runId)
  const latest = findLatestCheckpoint(events, stepId)
  if (!latest) return null
  try {
    const result = await resumer({
      runId,
      stepId,
      checkpointKey: latest.checkpointKey,
      state: latest.state,
    })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the latest checkpoint payload for a step out of an event log slice.
 * Exported for tests + the resume-controller's introspection.
 */
export function findLatestCheckpoint(
  events: WorkflowRunEventRow[],
  stepId: string
): { checkpointKey: string; state: unknown } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e.stepId !== stepId) continue
    if (e.type !== "step.long_running.checkpoint") continue
    const payload = e.payload as { checkpointKey?: string; state?: unknown } | undefined
    if (!payload || typeof payload.checkpointKey !== "string") continue
    return { checkpointKey: payload.checkpointKey, state: payload.state }
  }
  return null
}
