/**
 * The OS processes a scheduled task left behind, from the schedule's side.
 *
 * Two of the scheduler's task types reach the host's process supervisor.
 * `background-command` spawns a real OS process through
 * `crates/cognia-jobs`, in its own process group, with its PID recorded in
 * SQLite. `monitor` registers a watcher with the same supervisor. Both of them
 * outlive the execution that started them, on purpose: the execution's job is
 * to *start* the work, so it completes in milliseconds while the thing it
 * started runs for as long as it runs.
 *
 * That is exactly why the panel needed this. A scheduled `background-command`
 * showed a green "completed" run and gave no hint that a process was still
 * alive, and the only surface that listed it, the status-bar Job Center,
 * labelled its owner with a raw task id. So the schedule could start
 * long-running processes and then could not tell you about a single one of
 * them, and the place that could tell you did not know their names.
 *
 * Everything here is a read plus a kill against the supervisor. There is no
 * new storage: the supervisor's own job table is the truth, and mirroring it
 * into Dexie would only create a second answer to "is it still running".
 */

import {
  cancelBackgroundMonitor,
  killBackgroundJob,
  listBackgroundJobs,
  listBackgroundMonitors,
  type BackgroundJobRecord,
  type BackgroundMonitorRecord,
} from "@/lib/jobs/background-jobs"
import { getTaskTypeHostSupport } from "./host-support"

/**
 * What the schedule knows about one task's processes.
 *
 * `supported: false` is a distinct answer from an empty list, and the
 * distinction is the whole point. A browser or the mobile webview has no
 * process supervisor at all, so "nothing is running" and "this host could
 * never run one" must not render the same, or a user on their phone reads an
 * empty list as proof their desktop backup finished.
 */
export type TaskProcesses =
  | { supported: false; reason: string }
  | { supported: true; jobs: BackgroundJobRecord[]; monitors: BackgroundMonitorRecord[] }

/** Whether a task of this type can have host processes at all. */
export function taskTypeSpawnsProcesses(type: string): boolean {
  return type === "background-command" || type === "monitor"
}

function ownedBy(
  owner: BackgroundJobRecord["owner"] | BackgroundMonitorRecord["owner"],
  taskId: string
): boolean {
  return owner.kind === "scheduledTask" && owner.taskId === taskId
}

/**
 * The jobs and monitors this task owns right now.
 *
 * Filtered client-side from the full list rather than through an owner-scoped
 * query, because the supervisor's list command takes an owner filter whose
 * shape is a serialized enum and the whole list is bounded by
 * `MAX_JOBS_GLOBAL` anyway. Reading everything and filtering costs a few dozen
 * rows and keeps this module free of a second wire contract to maintain.
 */
export async function listTaskProcesses(task: {
  id: string
  type: string
}): Promise<TaskProcesses> {
  const support = getTaskTypeHostSupport(task.type as never)
  if (!support.supported) {
    return {
      supported: false,
      reason: "This host has no process supervisor, so it cannot run or show these.",
    }
  }

  try {
    const [jobs, monitors] = await Promise.all([listBackgroundJobs(), listBackgroundMonitors()])
    return {
      supported: true,
      jobs: jobs.filter((job) => ownedBy(job.owner, task.id)),
      monitors: monitors.filter((monitor) => ownedBy(monitor.owner, task.id)),
    }
  } catch {
    // The host claims the capability but the supervisor did not answer. Web
    // builds reach here through a transport with no such command. Reported as
    // unsupported rather than as an empty list, for the same reason as above.
    return {
      supported: false,
      reason: "The process supervisor did not answer on this host.",
    }
  }
}

/** True while the job is still holding a process. */
export function isJobLive(job: BackgroundJobRecord): boolean {
  return job.status === "running"
}

/** True while the monitor is still waiting on its condition. */
export function isMonitorLive(monitor: BackgroundMonitorRecord): boolean {
  return monitor.status === "waiting"
}

/**
 * How many live processes a task is holding, for a badge.
 *
 * Settled jobs are excluded deliberately. A count that included yesterday's
 * exited runs would be a number the user cannot act on, and the row it labels
 * offers a kill button.
 */
export function countLiveProcesses(processes: TaskProcesses): number {
  if (!processes.supported) return 0
  return processes.jobs.filter(isJobLive).length + processes.monitors.filter(isMonitorLive).length
}

/**
 * Stop one job. Kills the whole process group, not just the direct child.
 *
 * The supervisor spawns into its own group (`setsid` on Unix,
 * `CREATE_NEW_PROCESS_GROUP` on Windows) precisely so that a scheduled
 * `npm run build` does not leave its children behind when the user stops it.
 */
export function killTaskJob(jobId: string): Promise<BackgroundJobRecord> {
  return killBackgroundJob(jobId)
}

/**
 * Task names for the ids a supervisor row carries.
 *
 * The Job Center lists jobs by owner, and a `scheduledTask` owner is a bare id.
 * "scheduledTask xR9k2..." is not something a user can act on, and it is the
 * only label the one surface that CAN stop these processes ever showed. This
 * resolves the ids so that list can name the schedule instead.
 *
 * A task deleted while its process outlived it is simply absent from the map,
 * which is a real state: killing an orphan is exactly when this list matters
 * most, so the caller falls back to the id rather than hiding the row.
 */
export async function resolveScheduledTaskNames(
  taskIds: readonly string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(taskIds))
  if (unique.length === 0) return new Map()

  const { schedulerDb } = await import("./scheduler-db")
  const names = new Map<string, string>()
  await Promise.all(
    unique.map(async (id) => {
      try {
        const task = await schedulerDb.getTask(id)
        if (task) names.set(id, task.name)
      } catch {
        // One unreadable row must not cost the caller every other name.
      }
    })
  )
  return names
}

/** Stop one monitor without touching the job it may be watching. */
export function cancelTaskMonitor(monitorId: string): Promise<BackgroundMonitorRecord> {
  return cancelBackgroundMonitor(monitorId)
}
