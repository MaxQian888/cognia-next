import type { PluginRow } from "@/lib/db/plugin-types"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type { WorkflowExecutionBinding } from "@/types/workflow/deployment"

export class WorkflowPluginLockError extends Error {
  readonly retryable = false

  constructor(
    readonly code: "plugin-not-locked" | "plugin-version-drift" | "plugin-manifest-drift",
    message: string
  ) {
    super(message)
    this.name = "WorkflowPluginLockError"
  }
}

/** Enforce an immutable app release's plugin selection at execution time. */
export function assertWorkflowPluginDependencyLock(
  executionBinding: WorkflowExecutionBinding | undefined,
  plugin: PluginRow
): void {
  const pluginLock = executionBinding?.dependencyLock?.plugins
  // Old workflows and non-app runs predate plugin locks and remain readable.
  if (!pluginLock) return
  const locked = pluginLock[plugin.id]
  if (!locked) {
    throw new WorkflowPluginLockError(
      "plugin-not-locked",
      `Plugin ${plugin.id} is not part of this immutable workflow release.`
    )
  }
  if (locked.version !== plugin.version) {
    throw new WorkflowPluginLockError(
      "plugin-version-drift",
      `Plugin ${plugin.id} changed from locked version ${locked.version} to ${plugin.version}.`
    )
  }
  if (locked.manifestDigest !== workflowVersionDigest(plugin.manifest)) {
    throw new WorkflowPluginLockError(
      "plugin-manifest-drift",
      `Plugin ${plugin.id} manifest changed after workflow publication.`
    )
  }
}
