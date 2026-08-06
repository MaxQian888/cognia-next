import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import type {
  WorkflowDeployment,
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

/** Resolve an active pointer and hydrate exactly the immutable graph it selects. */
export async function resolveWorkflowDeployment(
  workflowId: string,
  environment = "production",
  provenance: { entrypoint?: WorkflowEntrypoint; caller?: string; idempotencyKey?: string } = {}
): Promise<ResolvedWorkflowDeployment | undefined> {
  const deployment = await getWorkflowDeployment(workflowId, environment)
  if (!deployment || deployment.status !== "active") return undefined
  const version = await getWorkflowVersion(deployment.versionId)
  if (!version || version.workflowId !== workflowId || version.accountId !== deployment.accountId) {
    throw new Error(`Workflow deployment ${deployment.id} points to an invalid version`)
  }
  const binding: WorkflowExecutionBinding = {
    versionId: version.id,
    deploymentId: deployment.id,
    deploymentRevision: deployment.revision,
    entrypoint: provenance.entrypoint ?? "trigger",
    caller: provenance.caller ?? "internal",
    ...(provenance.idempotencyKey ? { idempotencyKey: provenance.idempotencyKey } : {}),
  }
  return { deployment, version, workflow: version.definition, binding }
}

export async function resolveWorkflowDeploymentById(
  deploymentId: string,
  provenance: { entrypoint?: WorkflowEntrypoint; caller?: string; idempotencyKey?: string } = {}
): Promise<ResolvedWorkflowDeployment | undefined> {
  const deployment = await getWorkflowDeploymentById(deploymentId)
  if (!deployment || deployment.status !== "active") return undefined
  const version = await getWorkflowVersion(deployment.versionId)
  if (
    !version ||
    version.workflowId !== deployment.workflowId ||
    version.accountId !== deployment.accountId
  ) {
    throw new Error(`Workflow deployment ${deployment.id} points to an invalid version`)
  }
  return {
    deployment,
    version,
    workflow: version.definition,
    binding: {
      versionId: version.id,
      deploymentId: deployment.id,
      deploymentRevision: deployment.revision,
      entrypoint: provenance.entrypoint ?? "http",
      caller: provenance.caller ?? "anonymous",
      ...(provenance.idempotencyKey ? { idempotencyKey: provenance.idempotencyKey } : {}),
    },
  }
}
