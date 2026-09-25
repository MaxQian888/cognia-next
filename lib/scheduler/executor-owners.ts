/**
 * Which module owns the executor of a task type that `registerBuiltInExecutors()`
 * does not register, so the scheduler can load it when the task comes due.
 *
 * `initSchedulerSystem` registers the built-ins and then installs the schedules
 * subsystems own, such as the provider-diagnostics refresh clock. It is not the
 * only way the scheduler starts. `TaskSchedulerImpl.scheduleTask` also starts
 * it when a lifecycle write (plugin activation, a subsystem's own schedule)
 * arrives before the scheduler initializer mounts, and that scheduler arms every
 * persisted active task. A task whose executor only the skipped boot registers
 * then waited out `EXECUTOR_REGISTRATION_GRACE_MS` and failed with
 * `EXECUTOR_NOT_FOUND` on every tick, while `/scheduler` kept listing it Active.
 * The persisted row outlives the boot that seeded it, so registration has to
 * follow the scheduler, not the boot.
 *
 * A type belongs here when its executor lives in a subsystem module, runs on
 * every host the scheduler runs on, and needs nothing beyond that module to
 * register. Deliberately absent:
 *
 * - `connection:*`: each task binds one adapter instance whose runtime lives in
 *   the `integrations` boot bundle. A missing executor means that adapter is
 *   not running, which the boot grace and `connection-task-orphans.ts` handle.
 * - the built-in types: `registerBuiltInExecutors()` registers them.
 *
 * Pure leaf. The owners load with `import()`, so the scheduler's static graph
 * stays as small as it was and the owner module's own import of the scheduler
 * is not a cycle.
 */

import type { ScheduledTaskType } from "@/types/scheduler"

/** Imports the owning module and registers the executor with the scheduler. */
export type TaskExecutorOwner = () => Promise<void>

export const TASK_EXECUTOR_OWNERS: Readonly<Partial<Record<ScheduledTaskType, TaskExecutorOwner>>> =
  Object.freeze({
    "provider-diagnostics-refresh": async () => {
      const { registerProviderDiagnosticsRefreshExecutor } =
        await import("@/lib/provider-diagnostics/refresh")
      registerProviderDiagnosticsRefreshExecutor()
    },
  })

/** True when a module is declared to own `type`'s executor. */
export function hasTaskExecutorOwner(type: string): boolean {
  return Object.hasOwn(TASK_EXECUTOR_OWNERS, type)
}

/**
 * Load the owner of `type`'s executor. Resolves `true` once the owner ran and
 * `false` when no owner is declared. Rejects when the owner fails to load, so
 * the caller can record why before falling back to its boot grace.
 */
export async function loadTaskExecutorOwner(type: string): Promise<boolean> {
  if (!hasTaskExecutorOwner(type)) return false
  await TASK_EXECUTOR_OWNERS[type as ScheduledTaskType]!()
  return true
}
