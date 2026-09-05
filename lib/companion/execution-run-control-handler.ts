/**
 * `execution_run_control`: the one remote control seam for a run (ADR-0169).
 *
 * A paired phone, the CLI over the companion plane or an IM callback submits
 * the SAME `RunControlCommand` the desktop cockpit builds: revision-checked,
 * idempotent, with the typed review decision when it answers a Squad review.
 * It goes through `executeRunControlCommand`, so every rule that gate applies
 * on the desktop (revision conflicts, duplicate detection, decision
 * validation, authorization) applies to a remote caller unchanged, and the
 * result is the same `RunControlResult` the cockpit renders.
 *
 * The actor is the authenticated caller. The Rust side stamps `deviceId` from
 * the session (this command is in `CALLER_DEVICE_ID_COMMANDS`), so a payload
 * cannot borrow another device's name. A paired device that reached this arm
 * passed the Remote Control capability gate, and is therefore an operator for
 * the run it controls.
 *
 * The retired `team_run_pause|resume|stop` commands answer `upgrade-required`:
 * they addressed a TEAM, not a run, carried no revision and no decision, and
 * an older client that still sends them cannot render the projected snapshot
 * this contract assumes. Read-only history keeps working for it.
 */

import { executeRunControlCommand, type RunControlResult } from "@/lib/execution/run-control"
import { isWellFormedSquadReviewDecision } from "@/lib/execution/squad-review-decision"
import { localConsoleOperatorIds } from "@/lib/execution/local-operator"
import type { RunControlAction, RunControlCommand } from "@/types/execution/run"

const ACTIONS: ReadonlySet<string> = new Set<RunControlAction>([
  "pause",
  "resume",
  "stop",
  "retry",
  "approve",
  "deny",
  "steer",
  "open_details",
])

export const UPGRADE_REQUIRED_RESULT = { ok: false, reason: "upgrade-required" } as const

export interface ExecutionRunControlRejection {
  ok: false
  reason: "invalid-payload"
  field?: string
}

export type ExecutionRunControlOutcome = RunControlResult | ExecutionRunControlRejection

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Build the command from a remote payload, or say which field is wrong. */
export function parseExecutionRunControlPayload(
  payload: Record<string, unknown>
): { ok: true; command: RunControlCommand } | ExecutionRunControlRejection {
  const runId = readString(payload, "runId")
  if (!runId) return { ok: false, reason: "invalid-payload", field: "runId" }
  const action = readString(payload, "action")
  if (!action || !ACTIONS.has(action)) {
    return { ok: false, reason: "invalid-payload", field: "action" }
  }
  const idempotencyKey = readString(payload, "idempotencyKey")
  if (!idempotencyKey) return { ok: false, reason: "invalid-payload", field: "idempotencyKey" }
  const expectedRevision = payload.expectedRevision
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
    return { ok: false, reason: "invalid-payload", field: "expectedRevision" }
  }
  const interruptId = readString(payload, "interruptId")
  const steerMessage = readString(payload, "steerMessage")
  const reviewDecision = payload.reviewDecision
  if (reviewDecision !== undefined && !isWellFormedSquadReviewDecision(reviewDecision)) {
    return { ok: false, reason: "invalid-payload", field: "reviewDecision" }
  }
  const deviceId = readString(payload, "deviceId")
  const displayName = readString(payload, "deviceName")
  return {
    ok: true,
    command: {
      runId,
      action: action as RunControlAction,
      idempotencyKey,
      expectedRevision,
      actor: {
        ...(deviceId ? { remoteUserId: deviceId } : {}),
        ...(displayName ? { displayName } : {}),
      },
      ...(interruptId ? { interruptId } : {}),
      ...(reviewDecision !== undefined ? { reviewDecision } : {}),
      ...(steerMessage ? { steerMessage } : {}),
    },
  }
}

export async function handleExecutionRunControl(
  payload: Record<string, unknown>,
  deps: {
    execute?: typeof executeRunControlCommand
    operatorIds?: () => readonly string[]
  } = {}
): Promise<ExecutionRunControlOutcome> {
  const parsed = parseExecutionRunControlPayload(payload)
  if (!parsed.ok) return parsed
  const deviceId = parsed.command.actor.remoteUserId
  const operatorIds = [
    ...(deps.operatorIds ?? localConsoleOperatorIds)(),
    ...(deviceId ? [deviceId] : []),
  ]
  return (deps.execute ?? executeRunControlCommand)(parsed.command, { operatorIds })
}

/** The retired team-addressed controls. Older clients get told to upgrade. */
export async function handleLegacyTeamRunControl(): Promise<typeof UPGRADE_REQUIRED_RESULT> {
  return UPGRADE_REQUIRED_RESULT
}
