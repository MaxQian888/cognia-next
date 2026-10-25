import {
  hostGrantGate,
  type HostGrantGate,
  type RuntimeSnapshot,
} from "@/lib/runtime/operation-availability"
import { isTauri, transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"

/** What every `fleet_worker_*` command needs (`protocol/companion-commands.json`). */
export const EXECUTION_WORKERS_CAPABILITY = "host.admin"

/**
 * Whether this client may ask its Host about execution workers now.
 *
 * The desktop asks its own process. A paired client asks the Host, which
 * refuses a device without `host.admin` (`missing_capability`, final), and the
 * device console used to ask again every five seconds. So a client the Host
 * has said lacks the grant does not ask, and one still waiting for the Host's
 * manifest waits instead of collecting the same refusal at page load. One
 * whose grants are unknown still asks, and the Host's answer decides.
 */
export function executionWorkersAccess(snapshot: RuntimeSnapshot): HostGrantGate {
  if (isTauri()) return "ask"
  return hostGrantGate(snapshot, EXECUTION_WORKERS_CAPABILITY)
}

export interface WorkerEnrollmentIssue {
  enrollment: string
  expiresAtMs: number
  baseUrl: string
  fingerprint: string
  tenantId: string
}

export interface WorkerDeviceSummary {
  deviceId: string
  hostRef: string
  displayName: string
  role: string
  status: string
  createdAt: number
  updatedAt: number
  capabilities: string[]
}

export function workerEnrollmentCommand(issue: WorkerEnrollmentIssue): string {
  const command = [
    "cognia-agent worker enroll",
    `--server-url ${JSON.stringify(issue.baseUrl)}`,
    `--tenant-id ${JSON.stringify(issue.tenantId)}`,
    `--enrollment ${JSON.stringify(issue.enrollment)}`,
  ]
  if (issue.fingerprint) command.push(`--fingerprint ${JSON.stringify(issue.fingerprint)}`)
  return command.join(" ")
}

export async function createWorkerEnrollment(): Promise<WorkerEnrollmentIssue> {
  if (isTauri()) {
    return transport.call<WorkerEnrollmentIssue>("companion_create_worker_enrollment")
  }
  const config = loadCompanionConfig()
  if (!config) throw new Error("companion_not_connected")
  return transport.call<WorkerEnrollmentIssue>("fleet_worker_enrollment_create", {
    baseUrl: config.baseUrl,
    fingerprint: config.serverFingerprint ?? "",
  })
}

export async function listExecutionWorkers(): Promise<WorkerDeviceSummary[]> {
  const command = isTauri() ? "companion_list_workers" : "fleet_worker_list"
  return (await transport.call<WorkerDeviceSummary[]>(command)) ?? []
}

export async function revokeExecutionWorker(deviceId: string): Promise<void> {
  await transport.call<void>(isTauri() ? "companion_set_worker" : "fleet_worker_set", {
    deviceId,
    allowed: false,
  })
}
