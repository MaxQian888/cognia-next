/**
 * Kill a scheduled command that has run past its limit.
 *
 * A `background-command` task spawns a real OS process and its execution
 * settles immediately, because the execution's job is to start the work. From
 * that moment nothing was watching. `executeWithTimeout` bounds the
 * EXECUTION, which had already finished, and the jobs supervisor enforces a
 * count (`MAX_JOBS_GLOBAL`) but never a duration. The only thing that ever
 * ended a runaway was quitting the app, which kills every job on shutdown.
 *
 * So a nightly build that wedged on a prompt held a core until the user
 * noticed, and "the user noticed" was the entire mechanism.
 *
 * `maxRuntimeMs` is opt-in per task. There is deliberately no default: the
 * whole point of `background-command` is work that outlives its run, and a
 * scheduler that silently killed a long job at some invented hour would be a
 * worse failure than the one this fixes. A task with no limit set behaves
 * exactly as it did before.
 *
 * The selection is a pure function so the rule can be read and tested without
 * a supervisor, a clock or a database.
 */

import type { BackgroundJobRecord } from "@/lib/jobs/background-jobs"
import type { BackgroundCommandTaskPayload, ScheduledTask } from "@/types/scheduler"

/** A job that has outlived its task's limit, and by how much. */
export interface OverrunJob {
  jobId: string
  taskId: string
  taskName: string
  /** How long it had been running when the sweep saw it. */
  ranForMs: number
  /** The limit it passed. */
  limitMs: number
}

/**
 * The limit for a task, or `undefined` when it has none.
 *
 * Only `background-command` carries one. A `monitor` task is a registration
 * rather than a process, it holds no CPU, and it already has its own
 * `expiresAt`, so giving it a second expiry mechanism would mean two answers
 * to when a watch ends.
 */
export function taskRuntimeLimitMs(
  task: Pick<ScheduledTask, "type" | "payload">
): number | undefined {
  if (task.type !== "background-command") return undefined
  const payload = task.payload as Partial<BackgroundCommandTaskPayload> | undefined
  const limit = payload?.maxRuntimeMs
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined
  return limit
}

export interface SelectOverrunInput {
  jobs: readonly BackgroundJobRecord[]
  /** The scheduled tasks that own them, by id. */
  tasksById: ReadonlyMap<string, Pick<ScheduledTask, "id" | "name" | "type" | "payload">>
  nowMs: number
}

/**
 * Which running jobs have passed their owning task's limit.
 *
 * A job whose task is gone is left alone. Deleting a task does not kill what
 * it started (that is a separate decision, and one the user makes explicitly
 * from the panel), and inventing a limit for an orphan would mean this sweep
 * killing processes under a rule nobody set.
 */
export function selectOverrunJobs(input: SelectOverrunInput): OverrunJob[] {
  const { jobs, tasksById, nowMs } = input
  const overrun: OverrunJob[] = []

  for (const job of jobs) {
    if (job.status !== "running") continue
    if (job.owner.kind !== "scheduledTask") continue

    const task = tasksById.get(job.owner.taskId)
    if (!task) continue

    const limitMs = taskRuntimeLimitMs(task)
    if (limitMs === undefined) continue

    const ranForMs = nowMs - job.startedAtMs
    // Strictly greater, so a limit of exactly N does not kill at the instant
    // it is reached and race a process that was about to exit cleanly.
    if (ranForMs <= limitMs) continue

    overrun.push({ jobId: job.id, taskId: task.id, taskName: task.name, ranForMs, limitMs })
  }

  return overrun
}

/** Human-readable summary for the run record the sweep leaves behind. */
export function describeOverrun(job: OverrunJob): string {
  const ranForSeconds = Math.round(job.ranForMs / 1000)
  const limitSeconds = Math.round(job.limitMs / 1000)
  return `Killed after ${ranForSeconds}s, past this task's ${limitSeconds}s limit`
}
