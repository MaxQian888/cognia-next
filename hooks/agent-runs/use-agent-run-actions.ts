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
 * Everything now goes through `executeRunControlCommand`, and the real result
 * taxonomy is returned rather than swallowed. A caller that cannot tell
 * `revision_conflict` from `forbidden` from `steer_degraded` has to show the
 * user one generic failure for three problems with three different fixes.
 *
 * ## Why the run is re-read before dispatch
 *
 * `expectedRevision` is optimistic concurrency: "act only if the run is still
 * where I saw it". Feeding it the revision captured at render time sounds
 * stricter but is wrong here — this list is live-queried, so a running chat
 * turn bumps its revision every few hundred milliseconds against its OWN
 * progress. Every Stop press would answer `revision_conflict` and the button
 * would simply not work.
 *
 * So the run is re-read immediately before dispatch and its current revision
 * used, exactly as the one existing production caller does
 * (`lib/connectors/follow-up-control.ts`). The check that carries the real
 * weight is the one beside it: `allowedActions` is re-read from the fresh
 * snapshot, so a run that finished, was already retried, or lost its pending
 * approval between paint and click refuses the action instead of performing it.
 */

import { useCallback, useMemo, useRef, useState } from "react"

import { getExecutionRun } from "@/lib/db/execution-runs"
import { executeRunControlCommand, type RunControlResult } from "@/lib/execution/run-control"
import { localConsoleActor, localConsoleOperatorIds } from "@/lib/execution/local-operator"
import { useHostProfile } from "@/hooks/use-host-profile"
import { transport } from "@/lib/tauri/transport-instance"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { RunControlAction, SquadReviewDecision } from "@/types/execution/run"

/**
 * Everything the cockpit needs to explain what happened.
 *
 * `reason` widens `RunControlResult["reason"]` with the two refusals this layer
 * makes on its own behalf, so a caller switches over one union instead of
 * checking a boolean and then a second, differently-shaped error.
 */
export type RunControlOutcomeReason =
  | NonNullable<RunControlResult["reason"]>
  /** The row has no journal run behind it, so there is nothing to control. */
  | "not_controllable"
  /** The run no longer offers this action — it moved between paint and click. */
  | "action_unavailable"

export interface RunControlOutcome {
  accepted: boolean
  reason?: RunControlOutcomeReason
  /** Set with `steer_degraded`: the message is intact and still the caller's. */
  degradedReason?: RunControlResult["degradedReason"]
  /** Set on an accepted `retry` (and on its duplicate) — the replacement run. */
  retryRunId?: string
  /** True when the gate recognised this as a redelivery of a press it already took. */
  duplicate?: boolean
}

export interface RunControlDispatchOptions {
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

function outcomeFrom(result: RunControlResult): RunControlOutcome {
  return {
    accepted: result.accepted,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    ...(result.retryRunId ? { retryRunId: result.retryRunId } : {}),
    ...(result.duplicate ? { duplicate: true } : {}),
  }
}

/**
 * A companion shell (a paired phone, a browser driving a desktop) has no
 * lifecycle to control in-process: its control commands go to the desktop
 * host as `execution_run_control` (ADR-0169), the same `RunControlCommand`
 * through the same gate, and the host answers with the same result. The
 * revision check happens against the host's journal, so a stale mirror on
 * this device is answered `revision_conflict`, never acted on.
 */
function remoteControlHost(profile: string): boolean {
  return profile === "mobile-companion" || profile === "cloud-companion"
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
        const run = await getExecutionRun(row.runId)
        if (!run) return { accepted: false, reason: "run_not_found" }

        const snapshot = run.latestSnapshot
        if (!snapshot?.allowedActions.includes(action)) {
          return { accepted: false, reason: "action_unavailable" }
        }

        // Only ever set when the projection says an approval is open — the
        // reducer offers `approve`/`deny` exactly then, so this cannot silently
        // send an approve with nothing to approve.
        const interruptId =
          action === "approve" || action === "deny" ? snapshot.pendingInterrupt?.id : undefined

        const idempotencyKey =
          action === "steer"
            ? `cockpit:${run.id}:steer:${(steerSequence.current += 1)}`
            : `cockpit:${run.id}:${action}:${run.currentRevision}`

        const command = {
          runId: run.id,
          action,
          idempotencyKey,
          expectedRevision: run.currentRevision,
          actor: localConsoleActor(),
          ...(interruptId ? { interruptId } : {}),
          ...(options.steerMessage ? { steerMessage: options.steerMessage } : {}),
          ...(options.reviewDecision ? { reviewDecision: options.reviewDecision } : {}),
        }
        if (remoteControlHost(hostProfile)) {
          const { actor: _actor, ...payload } = command
          const remote = (await transport.call("execution_run_control", payload)) as
            RunControlResult | { ok: false; reason: string } | null
          if (remote && "accepted" in remote) return outcomeFrom(remote)
          return { accepted: false, reason: "invalid_command" }
        }
        const result = await executeRunControlCommand(command, {
          operatorIds: [...localConsoleOperatorIds()],
        })
        return outcomeFrom(result)
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
