import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { getWorkflow } from "@/lib/db/workflows"
import { updateWorkflowWithPublication } from "@/lib/workflow/publish/publication-lifecycle"
import type { WorkflowDependencyLock, WorkflowVersion } from "@/types/workflow/deployment"
import type { VisualWorkflow } from "@/types/workflow/visual"

export interface WorkflowVersionReferences {
  deployments: number
  appReleases: number
  invocations: number
  runs: number
  conversations: number
  dependencyLocks: number
}

export interface WorkflowVersionDetails {
  version: WorkflowVersion
  references: WorkflowVersionReferences
  currentEnvironments: string[]
  deletable: boolean
  deleteBlockers: string[]
}

export interface WorkflowVersionExport {
  format: "cognia-workflow-version"
  formatVersion: 1
  exportedAt: number
  workflowVersion: WorkflowVersion
}

export class WorkflowVersionInUseError extends Error {
  constructor(readonly blockers: string[]) {
    super(`Workflow version is in use: ${blockers.join(", ")}`)
    this.name = "WorkflowVersionInUseError"
  }
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function dependencyLockContainsVersion(
  lock: WorkflowDependencyLock | undefined,
  versionId: string
): boolean {
  if (!lock) return false
  return Object.values(lock.workflows).some(
    (binding) =>
      binding.versionId === versionId ||
      dependencyLockContainsVersion(binding.dependencyLock, versionId)
  )
}

async function ownedVersion(
  workflowId: string,
  versionId: string,
  accountId = getActiveAccountId()
): Promise<WorkflowVersion> {
  const version = await getDb().workflowVersions.get(versionId)
  if (!version || version.workflowId !== workflowId || version.accountId !== accountId) {
    throw new Error(`Workflow version ${versionId} does not belong to workflow ${workflowId}`)
  }
  return version
}

export async function getWorkflowVersionDetails(
  workflowId: string,
  versionId: string,
  accountId = getActiveAccountId()
): Promise<WorkflowVersionDetails> {
  const db = getDb()
  const version = await ownedVersion(workflowId, versionId, accountId)
  const [versions, deployments, appReleases, invocations, runs, conversations] = await Promise.all([
    db.workflowVersions.where("workflowId").equals(workflowId).toArray(),
    db.workflowDeployments.where("workflowId").equals(workflowId).toArray(),
    db.workflowAppReleases.where("workflowId").equals(workflowId).toArray(),
    db.workflowInvocations.toArray(),
    db.workflowRuns.toArray(),
    db.workflowConversations.where("accountId").equals(accountId).toArray(),
  ])
  const directInvocations = invocations.filter((row) => row.versionId === versionId).length
  const directRuns = runs.filter((row) => row.versionId === versionId).length
  const dependencyLocks =
    invocations.filter((row) => dependencyLockContainsVersion(row.dependencyLock, versionId))
      .length +
    runs.filter((row) => dependencyLockContainsVersion(row.dependencyLock, versionId)).length +
    appReleases.filter((row) => dependencyLockContainsVersion(row.dependencyLock, versionId)).length
  const references: WorkflowVersionReferences = {
    deployments: deployments.filter((row) => row.versionId === versionId).length,
    appReleases: appReleases.filter((row) => row.versionId === versionId).length,
    invocations: directInvocations,
    runs: directRuns,
    conversations: conversations.filter((row) => row.versionId === versionId).length,
    dependencyLocks,
  }
  const currentEnvironments = deployments
    .filter((row) => row.versionId === versionId)
    .map((row) => row.environment)
  const deleteBlockers = [
    ...(references.deployments ? ["deployment pointer"] : []),
    ...(references.appReleases ? ["app release"] : []),
    ...(references.invocations ? ["invocation"] : []),
    ...(references.runs ? ["run history"] : []),
    ...(references.conversations ? ["conversation"] : []),
    ...(references.dependencyLocks ? ["dependency lock"] : []),
    ...(versions.length <= 1 ? ["last version"] : []),
  ]
  return {
    version,
    references,
    currentEnvironments,
    deletable: deleteBlockers.length === 0,
    deleteBlockers,
  }
}

/** Copy a historical graph into the draft. The production pointer is preserved. */
export async function restoreWorkflowVersionToDraft(
  workflowId: string,
  versionId: string,
  at = Date.now()
): Promise<VisualWorkflow> {
  const [version, current] = await Promise.all([
    ownedVersion(workflowId, versionId),
    getWorkflow(workflowId),
  ])
  if (!current) throw new Error(`Workflow ${workflowId} not found`)
  const restored: VisualWorkflow = {
    ...cloneSerializable(version.definition),
    id: current.id,
    schemaVersion: 2,
    createdAt: current.createdAt,
    updatedAt: at,
    isBuiltIn: current.isBuiltIn,
    interface: current.interface,
    published: current.published,
  }
  const result = await updateWorkflowWithPublication(workflowId, restored, at)
  if (!result) throw new Error(`Workflow ${workflowId} not found`)
  return result.workflow
}

export async function exportWorkflowVersion(
  workflowId: string,
  versionId: string,
  exportedAt = Date.now()
): Promise<WorkflowVersionExport> {
  const version = await ownedVersion(workflowId, versionId)
  return {
    format: "cognia-workflow-version",
    formatVersion: 1,
    exportedAt,
    workflowVersion: cloneSerializable(version),
  }
}

export async function deleteWorkflowVersion(workflowId: string, versionId: string): Promise<void> {
  const details = await getWorkflowVersionDetails(workflowId, versionId)
  if (!details.deletable) throw new WorkflowVersionInUseError(details.deleteBlockers)
  const db = getDb()
  await db.transaction(
    "rw",
    [
      db.workflowVersions,
      db.workflowDeployments,
      db.workflowAppReleases,
      db.workflowInvocations,
      db.workflowRuns,
      db.workflowConversations,
    ],
    async () => {
      // Re-read immediately before deletion. IndexedDB transactions serialize
      // publication writes, while this guards a stale workbench detail panel.
      const latest = await getWorkflowVersionDetails(workflowId, versionId)
      if (!latest.deletable) throw new WorkflowVersionInUseError(latest.deleteBlockers)
      await db.workflowVersions.delete(versionId)
    }
  )
}
