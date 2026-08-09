import type { CogniaDB } from "@/lib/db/schema"
import { getDb } from "@/lib/db/schema"
import type { BootCapability } from "./capabilities"

interface ScheduledTaskProbeRow {
  status?: string
}

export interface StartupProbeDependencies {
  getDatabase: () => CogniaDB
  listScheduledTasks: () => Promise<ScheduledTaskProbeRow[]>
}

const defaultDependencies: StartupProbeDependencies = {
  getDatabase: getDb,
  listScheduledTasks: async () => {
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    return schedulerDb.tasks.toArray()
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
  const [plugins, adapters, memoryJobs, scheduledTasks] = await Promise.all([
    database.plugins.toArray(),
    database.adapterInstances.toArray(),
    database.memoryJobs.toArray(),
    dependencies.listScheduledTasks(),
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
  if (scheduledTasks.some((task) => task.status === "active")) {
    capabilities.add("workflow-automation")
  }
  if (adapters.some((adapter) => adapter.enabled)) {
    capabilities.add("integrations")
  }
  if (memoryJobs.some((job) => job.status === "queued" || job.status === "running")) {
    capabilities.add("knowledge-agents")
  }
  return [...capabilities]
}
