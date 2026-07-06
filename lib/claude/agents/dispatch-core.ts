// Shared fan-out core for the `dispatch_agent` tool, used by BOTH the renderer
// handler (`dispatch-agent-handler.ts`) and the CLI handler
// (`cli/src/agent/subagent-dispatch.ts`). Historically these diverged: the
// renderer serialized parallel siblings under a finite token budget, while the
// CLI always `Promise.all`-ed every sibling — so the CLI could overshoot a
// budget it didn't track and fan out unbounded. This module owns the ONE
// fan-out policy (single vs bounded-concurrency vs full-parallel) so the two
// hosts can't drift again. Everything host-specific (how one dispatch actually
// runs, budget checks, lifecycle recording) is injected.

import type { NormalizedDispatch } from "./dispatch-agent-tool"

/** The minimal per-dispatch result the core needs to combine + gate. */
export interface DispatchCoreOutcome {
  /** The text to surface for this dispatch (rendered result or error line). */
  text: string
  /** Whether this dispatch succeeded — drives the caller's all-failed policy. */
  ok: boolean
}

export interface RunDispatchFanoutParams {
  /** The normalized sibling dispatches to run (length ≥ 1). */
  dispatches: NormalizedDispatch[]
  /** Run ONE dispatch and resolve its outcome. MUST NOT throw — a host that can
   *  fail should resolve an `ok:false` outcome instead (mirrors both existing
   *  handlers, which never throw out of a single run). */
  runOne: (
    dispatch: NormalizedDispatch,
    label: string,
    index: number
  ) => Promise<DispatchCoreOutcome>
  /**
   * Max concurrent runs. `1` = serial (the renderer's finite-budget mode),
   * `Infinity` = full parallel (unlimited budget), any N = a bounded pool (the
   * CLI's new safety cap). Values < 1 are treated as 1.
   */
  width: number
  /**
   * Optional gate consulted BEFORE starting each not-yet-started dispatch. When
   * it returns true the remaining dispatches are short-circuited to a skipped
   * outcome instead of started (the renderer's mid-batch budget-exhausted stop).
   */
  shouldStop?: () => boolean
  /** Override the per-dispatch display label. Defaults to `id` (single) or
   *  `id#N` (fan-out), matching both existing handlers. */
  labelFor?: (dispatch: NormalizedDispatch, index: number, total: number) => string
  /** Text for a dispatch skipped by {@link shouldStop}. */
  skippedText?: (dispatch: NormalizedDispatch, label: string) => string
}

function defaultLabel(dispatch: NormalizedDispatch, index: number, total: number): string {
  return total === 1 ? dispatch.subagentId : `${dispatch.subagentId}#${index + 1}`
}

/**
 * Run the sibling dispatches with the given concurrency policy, preserving input
 * order in the returned outcomes. A single dispatch bypasses the pool entirely.
 * The pool never starts more than `width` runs at once and consults
 * `shouldStop` before starting each run, so a finite budget can halt a batch
 * mid-flight without cancelling already-running siblings.
 */
export async function runDispatchFanout(
  params: RunDispatchFanoutParams
): Promise<DispatchCoreOutcome[]> {
  const { dispatches, runOne, shouldStop } = params
  const total = dispatches.length
  const labelFor = params.labelFor ?? defaultLabel
  const width = Number.isFinite(params.width) ? Math.max(1, Math.floor(params.width)) : Infinity
  const skippedText =
    params.skippedText ??
    ((_d, label) => `[${label}] skipped — dispatch budget exhausted before it started.`)

  if (total === 1) {
    return [await runOne(dispatches[0], labelFor(dispatches[0], 0, 1), 0)]
  }

  const outcomes: DispatchCoreOutcome[] = new Array(total)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++
      if (i >= total) return
      const label = labelFor(dispatches[i], i, total)
      if (shouldStop?.()) {
        outcomes[i] = { text: skippedText(dispatches[i], label), ok: false }
        continue
      }
      outcomes[i] = await runOne(dispatches[i], label, i)
    }
  }

  const lanes = Math.min(width, total)
  await Promise.all(Array.from({ length: lanes }, () => worker()))
  return outcomes
}
