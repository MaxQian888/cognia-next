"use client"

/**
 * One operator press on a run, routed through the shared control plane.
 *
 * Every surface that lets a person control a run — the task cockpit, the
 * island overlay — builds the same `RunControlCommand` and sends it to the same
 * gate, so each gets the idempotency key, the revision check, the
 * authorization and the journal entry the control plane exists to provide.
 *
 * ## Why the run is re-read before dispatch
 *
 * `expectedRevision` is optimistic concurrency: "act only if the run is still
 * where I saw it". Feeding it the revision captured at render time sounds
 * stricter but is wrong here — a live-queried run bumps its revision every few
 * hundred milliseconds against its OWN progress, so every Stop press would
 * answer `revision_conflict` and the button would simply not work.
 *
 * So the run is re-read immediately before dispatch and its current revision
 * used, exactly as `lib/connectors/follow-up-control.ts` does. The check that
 * carries the real weight is the one beside it: `allowedActions` is re-read
 * from the fresh snapshot, so a run that finished, was already retried, or
 * lost its pending approval between paint and press refuses the action instead
 * of performing it.
 *
 * ## Remote hosts
 *
 * A companion shell (a paired phone, a browser driving a desktop) has no
 * lifecycle to control in-process: its commands go to the desktop host as
 * `execution_run_control` (ADR-0169), through the same gate, with the host's
 * answer. The desktop with a remote host ACTIVE is the same situation from the
 * other side: `RoutingTransport` already sent the turn to that host, so its
 * AbortController lives in the other process and a local control would answer
 * `source_rejected`.
 */

import { getExecutionRun } from "@/lib/db/execution-runs"
import { executeRunControlCommand, type RunControlResult } from "@/lib/execution/run-control"
import { localConsoleActor, localConsoleOperatorIds } from "@/lib/execution/local-operator"
import type { HostProfile } from "@/lib/platform/capabilities"
import { HostConsentRequiredError, issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { transport } from "@/lib/tauri/transport-instance"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { ExecutionRun, RunControlAction, SquadReviewDecision } from "@/types/execution/run"

/**
 * Everything a surface needs to explain what happened.
 *
 * `reason` widens `RunControlResult["reason"]` with the refusals this layer
 * makes on its own behalf, so a caller switches over one union instead of
 * checking a boolean and then a second, differently-shaped error.
 */
export type RunControlOutcomeReason =
  | NonNullable<RunControlResult["reason"]>
  /** The row has no journal run behind it, so there is nothing to control. */
  | "not_controllable"
  /** The run no longer offers this action — it moved between paint and press. */
  | "action_unavailable"
  /** A human must authorize this device's operation on the execution host. */
  | "host_consent_required"
  /** Transport or runtime failure; the caller can retry after checking the host. */
  | "control_failed"

export interface RunControlOutcome {
  accepted: boolean
  reason?: RunControlOutcomeReason
  /** Set with `steer_degraded`: the message is intact and still the caller's. */
  degradedReason?: RunControlResult["degradedReason"]
  /** Set on an accepted `retry` (and on its duplicate) — the replacement run. */
  retryRunId?: string
  /** True when the gate recognised this as a redelivery of a press it already took. */
  duplicate?: boolean
  /** Host-generated short code for completing the existing consent flow. */
  consentCode?: string
}

export interface RunControlDispatch {
  runId: string
  action: RunControlAction
  /** Names the pressing surface in the idempotency key (`cockpit`, `island`). */
  surface: string
  hostProfile: HostProfile
  /** Exact run revision and interrupt the user inspected; used only for approve/deny. */
  reviewedRun?: ExecutionRun
  /**
   * The approval the person answered, when the surface knows its real id. The
   * snapshot's `pendingInterrupt.id` is a display id that long or sensitive ids
   * are hashed into, so a surface holding the interrupt row passes it here.
   */
  interruptId?: string
  /** Required for `steer`; ignored otherwise. Never journalled. */
  steerMessage?: string
  /**
   * Distinguishes two deliberate steers from one double-press. Every other
   * action keys on the run's revision, so a double-press is correctly
   * answered as a duplicate; a steer must not be, or a second correction
   * typed in a row would be dropped.
   */
  steerSequence?: number
  /**
   * The typed answer to a Squad review (ADR-0169). Required by the gate for
   * an `approve` of every review kind except plan and capability audit.
   */
  reviewDecision?: SquadReviewDecision
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

function remoteControlHost(profile: HostProfile): boolean {
  return profile === "mobile-companion" || profile === "cloud-companion" || isRemoteHostActive()
}

export async function dispatchRunControl(input: RunControlDispatch): Promise<RunControlOutcome> {
  const { action } = input
  try {
    const reviewing = action === "approve" || action === "deny"
    if (reviewing && input.reviewedRun && input.reviewedRun.id !== input.runId) {
      return { accepted: false, reason: "invalid_command" }
    }
    // A fresh local mirror may name a different approval; bind a decision to the
    // exact details the person saw, including remote authoritative snapshots.
    const run =
      reviewing && input.reviewedRun ? input.reviewedRun : await getExecutionRun(input.runId)
    if (!run) return { accepted: false, reason: "run_not_found" }

    const snapshot = run.latestSnapshot
    if (!snapshot?.allowedActions.includes(action)) {
      return { accepted: false, reason: "action_unavailable" }
    }

    // Only ever set when the projection says an approval is open — the reducer
    // offers `approve`/`deny` exactly then, so this cannot silently send an
    // approve with nothing to approve.
    const interruptId = reviewing ? (input.interruptId ?? snapshot.pendingInterrupt?.id) : undefined

    const idempotencyKey =
      action === "steer"
        ? `${input.surface}:${run.id}:steer:${input.steerSequence ?? 0}`
        : `${input.surface}:${run.id}:${action}:${run.currentRevision}`

    const command = {
      runId: run.id,
      action,
      idempotencyKey,
      expectedRevision: run.currentRevision,
      actor: localConsoleActor(),
      ...(interruptId ? { interruptId } : {}),
      ...(input.steerMessage ? { steerMessage: input.steerMessage } : {}),
      ...(input.reviewDecision ? { reviewDecision: input.reviewDecision } : {}),
    }
    if (remoteControlHost(input.hostProfile)) {
      const { actor: _actor, ...payload } = command
      // This dispatch is the explicit user gesture. Mint only for this command
      // and use it immediately; never pre-grant on render or retry.
      const lease = await issueHostAdminLease(["execution_run_control"], 120)
      const remote = (await transport.call("execution_run_control", {
        ...payload,
        adminLease: lease.token,
      })) as RunControlResult | { ok: false; reason: string } | null
      if (remote && "accepted" in remote) return outcomeFrom(remote)
      return { accepted: false, reason: "invalid_command" }
    }
    const result = await executeRunControlCommand(command, {
      operatorIds: [...localConsoleOperatorIds()],
    })
    return outcomeFrom(result)
  } catch (error) {
    if (error instanceof HostConsentRequiredError) {
      return {
        accepted: false,
        reason: "host_consent_required",
        ...(error.consentCode ? { consentCode: error.consentCode } : {}),
      }
    }
    return { accepted: false, reason: "control_failed" }
  }
}
