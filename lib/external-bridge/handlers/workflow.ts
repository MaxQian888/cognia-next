/**
 * External Bridge adapter for immutable workflow deployments.
 *
 * Sidecar calls use the existing orchestration proxy. The `*Core` functions
 * run only inside the active Desktop/Headless host, where account-scoped
 * Dexie and the canonical workflow API service are available.
 */

import { proxyToHost } from "@/lib/external-bridge/orchestration-proxy-client"
import type {
  WorkflowApiEventView,
  WorkflowApiRunAccepted,
  WorkflowApiRunView,
} from "@/lib/workflow/api/workflow-api-service"
import { WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES } from "@/types/wiki"

const WORKFLOW_MCP_AUTHORITY_SCOPES = ["workflow:run", "workflow:read"] as const
const WORKFLOW_MCP_LIFECYCLE_TOOL_NAME_SET = new Set<string>(WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES)

export interface WorkflowMcpDeploymentDescriptor {
  deploymentId: string
  workflowId: string
  versionId: string
  revision: number
  environment: string
  name: string
  description?: string
  toolName: string
  inputSchema: Record<string, unknown>
}

export interface WorkflowMcpRunInput {
  deploymentId: string
  caller: string
  idempotencyKey?: string
  input: unknown
}

export interface WorkflowMcpRunRef {
  runId: string
}

export interface WorkflowMcpEventsInput extends WorkflowMcpRunRef {
  afterSequence: number
  limit?: number
}

export interface WorkflowMcpCancelInput extends WorkflowMcpRunRef {
  caller: string
}

export interface WorkflowMcpHost {
  listDeployments(): Promise<WorkflowMcpDeploymentDescriptor[]>
  createRun(input: WorkflowMcpRunInput): Promise<WorkflowApiRunAccepted>
  getRun(input: WorkflowMcpRunRef): Promise<WorkflowApiRunView>
  listEvents(input: WorkflowMcpEventsInput): Promise<{
    events: WorkflowApiEventView[]
    terminal: boolean
  }>
  cancelRun(input: WorkflowMcpCancelInput): Promise<{
    runId: string
    cancelled: boolean
    mode: string
  }>
}

function proxiedHostCall<T>(command: string, args: unknown[]): Promise<T> {
  return proxyToHost<T>(command, { arguments: args })
}

/** Production sidecar adapter. Desktop and Headless share this host proxy. */
export const proxiedWorkflowMcpHost: WorkflowMcpHost = {
  listDeployments: () => proxiedHostCall("workflowListDeployments", []),
  createRun: (input) => proxiedHostCall("workflowRunCreate", [input]),
  getRun: (input) => proxiedHostCall("workflowRunGet", [input]),
  listEvents: (input) => proxiedHostCall("workflowEventsList", [input]),
  cancelRun: (input) => proxiedHostCall("workflowRunCancel", [input]),
}

function collisionSuffix(deploymentId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < deploymentId.length; index += 1) {
    hash ^= deploymentId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** Host-side immutable deployment projection used by list + dynamic tools. */
export async function listWorkflowDeploymentsCore(): Promise<WorkflowMcpDeploymentDescriptor[]> {
  const [{ getActiveAccountId }, { getDb }, { redactText }, { toolNameForWorkflow }] =
    await Promise.all([
      import("@/lib/accounts/active-account-id"),
      import("@/lib/db/schema"),
      import("@cognia/redact"),
      import("@/lib/workflow/publish/publication-lifecycle"),
    ])
  const accountId = getActiveAccountId()
  const db = getDb()
  const deployments = (await db.workflowDeployments.toArray())
    .filter((deployment) => deployment.accountId === accountId)
    .sort((left, right) => left.id.localeCompare(right.id))
  const versions = await db.workflowVersions.bulkGet(
    deployments.map((deployment) => deployment.versionId)
  )

  const pending = deployments.map((deployment, index) => {
    const version = versions[index]
    if (
      !version ||
      version.accountId !== accountId ||
      version.workflowId !== deployment.workflowId
    ) {
      throw new Error(`Workflow deployment ${deployment.id} points to an invalid version`)
    }
    const name = redactText(version.name).redacted
    const description = version.description ? redactText(version.description).redacted : undefined
    const publishedToolName = toolNameForWorkflow({ name })
    return {
      deployment,
      version,
      name,
      description,
      baseToolName: `workflow_${publishedToolName.slice("wf_".length)}`,
    }
  })
  const baseCounts = new Map<string, number>()
  for (const item of pending) {
    baseCounts.set(item.baseToolName, (baseCounts.get(item.baseToolName) ?? 0) + 1)
  }

  return pending
    .filter(({ deployment }) => deployment.status === "active")
    .map(({ deployment, version, name, description, baseToolName }) => ({
      deploymentId: deployment.id,
      workflowId: deployment.workflowId,
      versionId: version.id,
      revision: deployment.revision,
      environment: deployment.environment,
      name,
      ...(description ? { description } : {}),
      toolName:
        (baseCounts.get(baseToolName) ?? 0) > 1 ||
        WORKFLOW_MCP_LIFECYCLE_TOOL_NAME_SET.has(baseToolName)
          ? `${baseToolName}_${collisionSuffix(deployment.id)}`
          : baseToolName,
      inputSchema: version.interface.inputSchema ?? { type: "object", properties: {} },
    }))
}

export async function createWorkflowRunCore(
  input: WorkflowMcpRunInput
): Promise<WorkflowApiRunAccepted> {
  const [{ getActiveAccountId }, { createWorkflowApiRun }] = await Promise.all([
    import("@/lib/accounts/active-account-id"),
    import("@/lib/workflow/api/workflow-api-service"),
  ])
  return createWorkflowApiRun({
    accountId: getActiveAccountId(),
    deploymentId: input.deploymentId,
    entrypoint: "mcp",
    caller: input.caller,
    scopes: WORKFLOW_MCP_AUTHORITY_SCOPES,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    input: input.input,
  })
}

export async function getWorkflowRunCore(input: WorkflowMcpRunRef): Promise<WorkflowApiRunView> {
  const [{ getActiveAccountId }, { getWorkflowApiRun }] = await Promise.all([
    import("@/lib/accounts/active-account-id"),
    import("@/lib/workflow/api/workflow-api-service"),
  ])
  return getWorkflowApiRun({
    accountId: getActiveAccountId(),
    runId: input.runId,
    scopes: WORKFLOW_MCP_AUTHORITY_SCOPES,
  })
}

export async function listWorkflowEventsCore(input: WorkflowMcpEventsInput): Promise<{
  events: WorkflowApiEventView[]
  terminal: boolean
}> {
  const [{ getActiveAccountId }, { listWorkflowApiEvents }] = await Promise.all([
    import("@/lib/accounts/active-account-id"),
    import("@/lib/workflow/api/workflow-api-service"),
  ])
  return listWorkflowApiEvents({
    accountId: getActiveAccountId(),
    runId: input.runId,
    scopes: WORKFLOW_MCP_AUTHORITY_SCOPES,
    afterSequence: input.afterSequence,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
}

export async function cancelWorkflowRunCore(input: WorkflowMcpCancelInput): Promise<{
  runId: string
  cancelled: boolean
  mode: string
}> {
  const [{ getActiveAccountId }, { cancelWorkflowApiRun }] = await Promise.all([
    import("@/lib/accounts/active-account-id"),
    import("@/lib/workflow/api/workflow-api-service"),
  ])
  return cancelWorkflowApiRun({
    accountId: getActiveAccountId(),
    runId: input.runId,
    scopes: WORKFLOW_MCP_AUTHORITY_SCOPES,
    caller: input.caller,
  })
}
