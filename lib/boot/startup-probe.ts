import type { CogniaDB } from "@/lib/db/schema"
import { getDb } from "@/lib/db/schema"
import type { BootCapability } from "./capabilities"

interface ScheduledTaskProbeRow {
  status?: string
}

export interface StartupProbeDependencies {
  getDatabase: () => CogniaDB
  listScheduledTasks: () => Promise<ScheduledTaskProbeRow[]>
  getTwinRuntimeSettings: () => Promise<{ workerEnabled?: boolean }>
}

const defaultDependencies: StartupProbeDependencies = {
  getDatabase: getDb,
  listScheduledTasks: async () => {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    return schedulerDb.tasks.toArray()
  },
  getTwinRuntimeSettings: async () => {
    const { getTwinRuntimeSettings } = await import("@/lib/db/twin-runtime-settings")
    return getTwinRuntimeSettings()
  },
}

/**
 * Lightweight main-profile probe. Optional runtimes remain dormant when they
 * have no work, while configured connectors, schedules, memory jobs, and
 * third-party startup plugins retain their background semantics.
 */
export async function probeConfiguredBootCapabilities(
  dependencies: StartupProbeDependencies = defaultDependencies
): Promise<BootCapability[]> {
  const database = dependencies.getDatabase()
  const [
    plugins,
    adapters,
    memoryJobs,
    twinJobs,
    pendingGoalVerifications,
    scheduledTasks,
    twinSettings,
  ] = await Promise.all([
    database.plugins.toArray(),
    database.adapterInstances.toArray(),
    database.memoryJobs.toArray(),
    database.twinJobs.toArray(),
    database.chatGoals
      .filter(
        (goal) =>
          Boolean(goal.config.verificationWorkflow) &&
          (goal.verification?.status === "requested" || goal.verification?.status === "running")
      )
      .count(),
    dependencies.listScheduledTasks(),
    dependencies.getTwinRuntimeSettings(),
  ])
  const capabilities = new Set<BootCapability>()

  if (
    plugins.some((plugin) => {
      if (!plugin.enabled || plugin.source === "builtin") return false
      const events = (plugin.manifest as { activationEvents?: unknown } | undefined)
        ?.activationEvents
      return (
        Array.isArray(events) &&
        events.some((event) => event === "startup" || event === "onStartup")
      )
    })
  ) {
    capabilities.add("plugin-runtime")
  }
  if (scheduledTasks.some((task) => task.status === "active") || pendingGoalVerifications > 0) {
    capabilities.add("workflow-automation")
  }
  if (adapters.some((adapter) => adapter.enabled)) {
    capabilities.add("integrations")
  }
  if (
    memoryJobs.some((job) => job.status === "queued" || job.status === "running") ||
    twinJobs.some((job) => job.status === "queued" || job.status === "running") ||
    twinSettings.workerEnabled
  ) {
    capabilities.add("knowledge-agents")
  }
  return [...capabilities]
}
