import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import type {
  WorkflowDeployment,
  WorkflowDependencyBinding,
  WorkflowEntrypoint,
  WorkflowExecutionBinding,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { getDb } from "./schema"

export async function listWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
  return getDb().workflowVersions.where("workflowId").equals(workflowId).sortBy("sequence")
}

export async function getWorkflowVersion(versionId: string): Promise<WorkflowVersion | undefined> {
  return getDb().workflowVersions.get(versionId)
}

export async function getWorkflowDeployment(
  workflowId: string,
  environment = "production",
  accountId = getActiveAccountId()
): Promise<WorkflowDeployment | undefined> {
  return getDb()
    .workflowDeployments.where("[accountId+workflowId+environment]")
    .equals([accountId, workflowId, environment])
    .first()
}

export async function getWorkflowDeploymentById(
  deploymentId: string,
  accountId = getActiveAccountId()
): Promise<WorkflowDeployment | undefined> {
  const deployment = await getDb().workflowDeployments.get(deploymentId)
  return deployment?.accountId === accountId ? deployment : undefined
}

export interface ResolvedWorkflowDeployment {
  deployment: WorkflowDeployment
  version: WorkflowVersion
  workflow: VisualWorkflow
  binding: WorkflowExecutionBinding
}

type DeploymentProvenance = {
  entrypoint?: WorkflowEntrypoint
  caller?: string
  idempotencyKey?: string
}

async function hydrateWorkflowDeployment(
  deployment: WorkflowDeployment | undefined,
  versionId: string | undefined,
  provenance: DeploymentProvenance,
  defaults: { entrypoint: WorkflowEntrypoint; caller: string }
): Promise<ResolvedWorkflowDeployment | undefined> {
  if (!deployment || !versionId) return undefined
  const version = await getWorkflowVersion(versionId)
  if (
    !version ||
    version.workflowId !== deployment.workflowId ||
    version.accountId !== deployment.accountId
  ) {
    throw new Error(`Workflow deployment ${deployment.id} points to an invalid version`)
  }
  return {
    deployment: { ...deployment, versionId, revision: deployment.revision },
    version,
    workflow: version.definition,
    binding: {
      versionId: version.id,
      deploymentId: deployment.id,
      deploymentRevision: deployment.revision,
      entrypoint: provenance.entrypoint ?? defaults.entrypoint,
      caller: provenance.caller ?? defaults.caller,
      ...(provenance.idempotencyKey ? { idempotencyKey: provenance.idempotencyKey } : {}),
    },
  }
}

/** Resolve an active pointer and hydrate exactly the immutable graph it selects. */
export async function resolveWorkflowDeployment(
  workflowId: string,
  environment = "production",
  provenance: { entrypoint?: WorkflowEntrypoint; caller?: string; idempotencyKey?: string } = {}
): Promise<ResolvedWorkflowDeployment | undefined> {
  const deployment = await getWorkflowDeployment(workflowId, environment)
  if (!deployment || deployment.status !== "active") return undefined
  return hydrateWorkflowDeployment(deployment, deployment.versionId, provenance, {
    entrypoint: "trigger",
    caller: "internal",
  })
}

export async function resolveWorkflowDeploymentById(
  deploymentId: string,
  provenance: { entrypoint?: WorkflowEntrypoint; caller?: string; idempotencyKey?: string } = {}
): Promise<ResolvedWorkflowDeployment | undefined> {
  const deployment = await getWorkflowDeploymentById(deploymentId)
  if (!deployment || deployment.status !== "active") return undefined
  return hydrateWorkflowDeployment(deployment, deployment.versionId, provenance, {
    entrypoint: "http",
    caller: "anonymous",
  })
}

/** Hydrate the exact version selected by an already-admitted parent run. */
export async function resolveLockedWorkflowDeployment(
  locked: WorkflowDependencyBinding,
  provenance: DeploymentProvenance = {}
): Promise<ResolvedWorkflowDeployment | undefined> {
  const deployment = await getWorkflowDeploymentById(locked.deploymentId)
  if (!deployment || deployment.workflowId !== locked.workflowId) return undefined
  const resolved = await hydrateWorkflowDeployment(
    { ...deployment, revision: locked.deploymentRevision },
    locked.versionId,
    provenance,
    { entrypoint: "subworkflow", caller: "internal" }
  )
  if (resolved && locked.dependencyLock) {
    resolved.binding.dependencyLock = locked.dependencyLock
  }
  return resolved
}
