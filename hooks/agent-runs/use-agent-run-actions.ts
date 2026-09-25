"use client"

/**
 * Run control for the task cockpit, routed through the shared control plane.
 *
 * This hook used to lazy-import `getGoalRuntime` / `getPlanRuntime` /
 * `abortTeam` and call them directly. That worked, and every guarantee the
 * control plane exists to provide was missing from it: no idempotency key (a
 * double-click fired twice), no `expectedRevision` check, no authorization, no
 * `control.accepted` / `control.rejected` in the journal, no steer, and no
 * coverage of `agent-turn`, `workflow`, `scheduled`, `delegation` or `job` —
 * which between them are most of what actually runs.
 *
 * Everything now goes through `dispatchRunControl`, the press path the island
 * overlay shares, and the real result taxonomy is returned rather than
 * swallowed. A caller that cannot tell `revision_conflict` from `forbidden`
 * from `steer_degraded` has to show the user one generic failure for three
 * problems with three different fixes. This hook only adds what a rendered
 * list needs on top: which row is waiting, and the steer sequence.
 */

import { useCallback, useMemo, useRef, useState } from "react"

import {
  dispatchRunControl,
  type RunControlOutcome,
  type RunControlOutcomeReason,
} from "@/lib/execution/run-control-dispatch"
import { useHostProfile } from "@/hooks/use-host-profile"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { ExecutionRun, RunControlAction, SquadReviewDecision } from "@/types/execution/run"

export type { RunControlOutcome, RunControlOutcomeReason }

export interface RunControlDispatchOptions {
  /** Exact run revision and interrupt the user inspected; used only for approve/deny. */
  reviewedRun?: ExecutionRun
  /** Required for `steer`; ignored otherwise. Never journalled. */
  steerMessage?: string
  /**
   * The typed answer to a Squad review (ADR-0169). Required by the gate for
   * an `approve` of every review kind except plan and capability audit.
   */
  reviewDecision?: SquadReviewDecision
}

export interface RunControlActions {
  /** The row currently awaiting a control result, if any. */
  pendingRowId: string | null
  /**
   * Whether to render a button for `action` on `row`.
   *
   * Answered from the projection's own `allowedActions`, never from the kind:
   * the per-kind rules (steer only where a live input lane exists, retry only
   * on a settled retryable kind that has not already been replaced) live in
   * `run-reducer.ts`, and a second copy here would drift from them.
   */
  can(row: UnifiedExecutionRow, action: RunControlAction): boolean
  dispatch(
    row: UnifiedExecutionRow,
    action: RunControlAction,
    options?: RunControlDispatchOptions
  ): Promise<RunControlOutcome>
}

export function useRunControlActions(): RunControlActions {
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const hostProfile = useHostProfile()
  /**
   * Distinguishes two deliberate steers from one double-click.
   *
   * Every other action keys on `${runId}:${action}:${revision}`, so a
   * double-click is correctly answered as a duplicate. A steer must not be: two
   * corrections typed in a row are two different instructions, and collapsing
   * them would silently drop the second.
   */
  const steerSequence = useRef(0)

  const can = useCallback((row: UnifiedExecutionRow, action: RunControlAction): boolean => {
    if (!row.runId || row.source !== "journal") return false
    return row.allowedActions?.includes(action) ?? false
  }, [])

  const dispatch = useCallback(
    async (
      row: UnifiedExecutionRow,
      action: RunControlAction,
      options: RunControlDispatchOptions = {}
    ): Promise<RunControlOutcome> => {
      if (!row.runId || row.source !== "journal") {
        return { accepted: false, reason: "not_controllable" }
      }
      setPendingRowId(row.rowId)
      try {
        return await dispatchRunControl({
          runId: row.runId,
          action,
          surface: "cockpit",
          hostProfile,
          ...options,
          ...(action === "steer" ? { steerSequence: (steerSequence.current += 1) } : {}),
        })
      } finally {
        setPendingRowId((current) => (current === row.rowId ? null : current))
      }
    },
    [hostProfile]
  )

  return useMemo<RunControlActions>(
    () => ({ pendingRowId, can, dispatch }),
    [pendingRowId, can, dispatch]
  )
}
