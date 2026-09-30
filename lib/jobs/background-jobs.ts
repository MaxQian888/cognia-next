import { transport } from "@/lib/tauri"

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

export type BackgroundMonitorCondition =
  | { kind: "jobExit"; jobId: string }
  | { kind: "jobOutput"; jobId: string; pattern: string }
  | {
      kind: "shellPredicate"
      command: string
      program: string
      args: string[]
      cwd: string
      env?: Record<string, string>
      intervalMs?: number
    }
  | { kind: "upstream"; source: string; id: string }

export async function listBackgroundJobs(
  owner?: BackgroundJobOwner
): Promise<BackgroundJobRecord[]> {
  const result = await transport.call<{ jobs: BackgroundJobRecord[] }>(
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
  const result = await transport.call<{ monitors: BackgroundMonitorRecord[] }>(
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
