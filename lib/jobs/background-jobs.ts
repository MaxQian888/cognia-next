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

export async function listBackgroundJobs(): Promise<BackgroundJobRecord[]> {
  const result = await transport.call<{ jobs: BackgroundJobRecord[] }>("background_job_list", {})
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
