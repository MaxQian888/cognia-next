"use client"

/** Client routing for a manual gesture; startSquadRun remains the only launch runtime. */
import type { StartSquadRunResult } from "@/lib/ai/agent/team/squad/start-squad-run"
import type { HostProfile } from "@/lib/platform/capabilities"
import { HostConsentRequiredError, issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"

export type SquadStartOutcome = Omit<StartSquadRunResult, "reason"> & {
  reason?:
    | StartSquadRunResult["reason"]
    | "invalid_payload"
    | "caller_device_required"
    | "host_consent_required"
    | "approval_required"
    | "permission_denied"
    | "start_failed"
    | "host_changed"
    | "offline"
  consentCode?: string
}

export interface SquadStartDispatch {
  teamId: string
  hostProfile: HostProfile
  goal?: string
  ultracode?: boolean
}

/** One logical gesture. Retries keep launchId, while every new lease has its own wire key. */
export function createSquadStartAttempt(input: SquadStartDispatch) {
  const launchId = crypto.randomUUID()
  const initialTransport = transport
  const initialRemote = getActiveRemoteTransport()
  const initialGeneration = getCompanionConfigGeneration()
  const target = initialRemote ?? initialTransport
  const remote =
    input.hostProfile === "mobile-companion" ||
    input.hostProfile === "cloud-companion" ||
    initialRemote !== null
  const { teamId, goal, ultracode } = input
  let pending: Promise<SquadStartOutcome> | undefined
  let accepted: SquadStartOutcome | undefined
  const sameHost = () =>
    transport === initialTransport &&
    getActiveRemoteTransport() === initialRemote &&
    getCompanionConfigGeneration() === initialGeneration

  const dispatch = async (): Promise<SquadStartOutcome> => {
    try {
      if (!sameHost()) return { started: false, reason: "host_changed" }
      if (!remote) {
        const { startSquadRun } = await import("@/lib/ai/agent/team/squad/start-squad-run")
        return await startSquadRun({
          squadId: teamId,
          runId: launchId,
          goal: goal ?? "",
          origin: "interactive",
          triggeredFrom: { source: "ui" },
          ...(ultracode !== undefined ? { ultracode } : {}),
        })
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return { started: false, reason: "offline" }
      }
      const lease = await issueHostAdminLease(["team_run_start"], 120, target)
      // A host switch during consent must never send the previous gesture to the new host.
      if (!sameHost()) return { started: false, reason: "host_changed" }
      const result = await target.call<SquadStartOutcome>(
        "team_run_start",
        {
          teamId,
          launchId,
          ...(goal !== undefined ? { goal } : {}),
          ...(ultracode !== undefined ? { ultracode } : {}),
          adminLease: lease.token,
        },
        { idempotencyKey: crypto.randomUUID() }
      )
      if (
        !result ||
        typeof result.started !== "boolean" ||
        (result.started && (!result.runId || !result.executionRunId))
      ) {
        return { started: false, reason: "start_failed" }
      }
      return result
    } catch (error) {
      if (error instanceof HostConsentRequiredError) {
        return {
          started: false,
          reason: "host_consent_required",
          ...(error.consentCode ? { consentCode: error.consentCode } : {}),
        }
      }
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      return {
        started: false,
        reason:
          code === "interactive_approval_required"
            ? "approval_required"
            : code === "permission_denied" || code === "forbidden"
              ? "permission_denied"
              : "start_failed",
      }
    }
  }
  return {
    launchId,
    dispatch(): Promise<SquadStartOutcome> {
      if (accepted) return Promise.resolve(accepted)
      if (!pending) {
        pending = dispatch()
          .then((result) => {
            if (result.started) accepted = result
            return result
          })
          .finally(() => {
            pending = undefined
          })
      }
      return pending
    },
  }
}
