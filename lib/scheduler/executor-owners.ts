/**
 * Which module owns the executor of each task type, so the scheduler can load
 * it when the task comes due.
 *
 * `initSchedulerSystem` registers the built-ins and then installs the schedules
 * subsystems own, such as the provider-diagnostics refresh clock. It is not the
 * only way the scheduler starts. `TaskSchedulerImpl.scheduleTask` also starts
 * it when a lifecycle write (plugin activation, a subsystem's own schedule)
 * arrives before the scheduler initializer mounts, and that scheduler arms every
 * persisted active task. A task whose executor only the skipped boot registers
 * then waited out `EXECUTOR_REGISTRATION_GRACE_MS` and failed with
 * `EXECUTOR_NOT_FOUND` on every tick, while `/scheduler` kept listing it Active.
 * That included the built-ins. When the `workflow-automation` boot chunk never
 * mounted, even the plugin task whose creation started the scheduler failed.
 * That happens with the development `main` boot profile, which requests the
 * chunk only on its routes or when boot finds an active task, with a chunk that
 * failed to load, and in a `cognia-agent run --plugin-tools` process, which has
 * no initializer. The persisted row outlives the boot that seeded it, so
 * registration has to follow the scheduler, not the boot.
 *
 * A type belongs here when its executor lives in a module that registers it on
 * every host the scheduler runs on and needs nothing beyond that module to do
 * so. Whether the host can actually run the task is a separate question,
 * answered per fire by `host-support.ts`. Deliberately absent:
 *
 * - `connection:*`: each task binds one adapter instance whose runtime lives in
 *   the `integrations` boot bundle. A missing executor means that adapter is
 *   not running, which the boot grace and `connection-task-orphans.ts` handle.
 * - the deprecated types (`DEPRECATED_TASK_TYPES`): nothing registers them.
 *
 * Pure leaf. The owners load with `import()`, so the scheduler's static graph
 * stays as small as it was and the owner modules' own imports of the scheduler
 * are not cycles.
 */

import type { ScheduledTaskType } from "@/types/scheduler"

/**
 * The task types `registerBuiltInExecutors()` (`./executors`) registers. That
 * function registers from a record typed against this list, so a type added to
 * one and not the other does not compile.
 */
export const BUILT_IN_EXECUTOR_TASK_TYPES = Object.freeze([
  "chat",
  "agent",
  "skill",
  "script",
  "background-command",
  "monitor",
  "plugin",
  "backup",
  "custom",
  "external-agent",
  "twin",
  "wiki-rebuild",
  "wiki-lint",
  "github-issue-sync",
  "radar-report",
  "agent-team",
  "goal",
  "plan",
  "bot",
  "test",
  "workflow",
  "im-push",
] as const satisfies readonly ScheduledTaskType[])

export type BuiltInExecutorTaskType = (typeof BUILT_IN_EXECUTOR_TASK_TYPES)[number]

/** Imports the owning module and registers the executor with the scheduler. */
export type TaskExecutorOwner = () => Promise<void>

/**
 * One owner for every built-in type. `registerBuiltInExecutors()` is
 * idempotent, so the second built-in type to come due costs a resolved
 * `import()` and nothing else, and `initSchedulerSystem` mounting later
 * registers nothing twice.
 */
const registerBuiltIns: TaskExecutorOwner = async () => {
  const { registerBuiltInExecutors } = await import("./executors")
  registerBuiltInExecutors()
}

export const TASK_EXECUTOR_OWNERS: Readonly<Partial<Record<ScheduledTaskType, TaskExecutorOwner>>> =
  Object.freeze({
    ...Object.fromEntries(BUILT_IN_EXECUTOR_TASK_TYPES.map((type) => [type, registerBuiltIns])),
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
