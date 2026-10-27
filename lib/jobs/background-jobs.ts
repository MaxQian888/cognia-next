import { transport } from "@/lib/tauri"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { BackgroundMonitorCondition } from "@cognia/plugin-contract/lib/jobs/background-jobs"
export type { BackgroundMonitorCondition } from "@cognia/plugin-contract/lib/jobs/background-jobs"

// The global job center can remount between turns. Keep final refusals at
// the read boundary, scoped to the caller and pairing, rather than its timer.
let listScope:
  | {
      remote: ReturnType<typeof getActiveRemoteTransport>
      pairing: number
      runtime: string
      refusals: Map<string, unknown>
    }
  | undefined

async function readSupervisorList<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const remote = getActiveRemoteTransport()
  const pairing = getCompanionConfigGeneration()
  const runtime = JSON.stringify(getActiveRuntimeTargetContext())
  if (
    listScope?.remote !== remote ||
    listScope.pairing !== pairing ||
    listScope.runtime !== runtime
  )
    listScope = { remote, pairing, runtime, refusals: new Map() }
  const scope = listScope
  const key = JSON.stringify([command, args])
  if (scope.refusals.has(key)) throw scope.refusals.get(key)
  try {
    return await transport.call<T>(command, args)
  } catch (error) {
    if ((error as { retryable?: unknown } | null)?.retryable === false)
      scope.refusals.set(key, error)
    throw error
  }
}

export type BackgroundJobOwner =
  | { kind: "session"; sessionId: string }
  | { kind: "scheduledTask"; taskId: string }
  | { kind: "app" }

export type BackgroundJobStatus = "running" | "exited" | "killed" | "interrupted" | "failed"

export interface BackgroundJobRecord {
  id: string
  command: string
  cwd: string
  owner: BackgroundJobOwner
  status: BackgroundJobStatus
  exitCode?: number
  pid?: number
  startedAtMs: number
  endedAtMs?: number
  totalOutputBytes: number
  droppedOutputBytes: number
  label?: string
}

export interface BackgroundJobOutput {
  fromOffset: number
  nextOffset: number
  data: string
  status: BackgroundJobStatus
  exitCode?: number
  hasMore: boolean
}

export interface BackgroundMonitorRecord {
  id: string
  condition: { kind: string; [key: string]: unknown }
  owner: BackgroundJobOwner
  status: "waiting" | "fired" | "unsatisfiable" | "cancelled" | "expired"
  createdAtMs: number
  settledAtMs?: number
  expiresAtMs?: number
  detail?: string
  label?: string
}

export async function listBackgroundJobs(
  owner?: BackgroundJobOwner
): Promise<BackgroundJobRecord[]> {
  const result = await readSupervisorList<{ jobs: BackgroundJobRecord[] }>(
    "background_job_list",
    owner ? { owner } : {}
  )
  return result.jobs
}

export async function readBackgroundJobTail(
  job: Pick<BackgroundJobRecord, "id" | "totalOutputBytes">,
  maxBytes = 8192
): Promise<BackgroundJobOutput> {
  return transport.call<BackgroundJobOutput>("background_job_read", {
    jobId: job.id,
    fromOffset: Math.max(0, job.totalOutputBytes - maxBytes),
    maxBytes,
  })
}

/**
 * Read a job's merged output from an absolute byte offset. Callers that need
 * the whole stream loop while `hasMore` is true, advancing `fromOffset` to
 * `nextOffset` (the scheduler script runner does this to capture stdout).
 */
export function readBackgroundJobOutput(
  jobId: string,
  fromOffset: number,
  maxBytes = 8192
): Promise<BackgroundJobOutput> {
  return transport.call<BackgroundJobOutput>("background_job_read", {
    jobId,
    fromOffset: Math.max(0, fromOffset),
    maxBytes,
  })
}

export function killBackgroundJob(jobId: string): Promise<BackgroundJobRecord> {
  return transport.call<BackgroundJobRecord>("background_job_kill", { jobId })
}

export function spawnScheduledBackgroundJob(input: {
  taskId: string
  command: string
  cwd: string
  label?: string
}): Promise<BackgroundJobRecord> {
  return transport.call<BackgroundJobRecord>("background_job_spawn_scheduled", input)
}

/**
 * Start a shell command for an External Bridge client. The host owns the job
 * under the synthetic session `external-bridge:jobs:<clientId>`, so the
 * per-session job cap and owner listing are per client.
 */
export function spawnBridgeBackgroundJob(input: {
  clientId: string
  command: string
  cwd: string
  label?: string
}): Promise<BackgroundJobRecord> {
  return transport.call<BackgroundJobRecord>("background_job_spawn_bridge", input)
}

/** The owner a bridge client's jobs are filed under (mirrors the Rust command). */
export function bridgeJobOwner(clientId: string): BackgroundJobOwner {
  return { kind: "session", sessionId: `external-bridge:jobs:${clientId}` }
}

/**
 * Start a chat composer's `!` line as a supervised job. `program` + `args` are
 * the argv built from the user's configured shell; `command` is the line as
 * typed, for display. The host files the job under
 * {@link chatShellJobOwner}, never under the bare session the agent owns.
 * `adminLease` is the step-up lease a paired client presents after the host
 * refused for want of interactive approval.
 */
export function spawnSessionBackgroundJob(input: {
  sessionId: string
  command: string
  program: string
  args: string[]
  cwd: string
  label?: string
  adminLease?: string
}): Promise<BackgroundJobRecord> {
  const { adminLease, ...request } = input
  return transport.call<BackgroundJobRecord>(
    "background_job_spawn_session",
    adminLease ? { ...request, adminLease } : request
  )
}

/** The owner a chat session's `!` jobs are filed under (mirrors the Rust command). */
export function chatShellJobOwner(sessionId: string): BackgroundJobOwner {
  return { kind: "session", sessionId: `chat-shell:${sessionId}` }
}

/**
 * Long-poll a job's output from `fromOffset`: resolves as soon as new bytes
 * land or the job settles, or after `waitMs` (the host caps it at 30s).
 */
export function waitBackgroundJobOutput(
  jobId: string,
  fromOffset: number,
  options: { maxBytes?: number; waitMs?: number } = {}
): Promise<BackgroundJobOutput> {
  return transport.call<BackgroundJobOutput>("background_job_wait", {
    jobId,
    fromOffset: Math.max(0, fromOffset),
    maxBytes: options.maxBytes ?? 8192,
    waitMs: options.waitMs ?? 0,
  })
}

export async function listBackgroundMonitors(): Promise<BackgroundMonitorRecord[]> {
  const result = await readSupervisorList<{ monitors: BackgroundMonitorRecord[] }>(
    "background_monitor_list",
    {}
  )
  return result.monitors
}

export function cancelBackgroundMonitor(monitorId: string): Promise<BackgroundMonitorRecord> {
  return transport.call<BackgroundMonitorRecord>("background_monitor_cancel", { monitorId })
}

export function registerScheduledBackgroundMonitor(input: {
  taskId: string
  condition: BackgroundMonitorCondition
  expiresAtMs?: number
  label?: string
}): Promise<BackgroundMonitorRecord> {
  return transport.call<BackgroundMonitorRecord>("background_monitor_register_scheduled", input)
}
