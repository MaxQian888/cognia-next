import type { VisualWorkflow, WorkflowInterface, WorkflowNodeKind } from "./visual"

export type WorkflowEnvironment = "production" | "staging" | "development" | (string & {})

export interface WorkflowDependencyManifest {
  nodeTypes: Array<{ kind: WorkflowNodeKind; typeVersion: number }>
  workflows: Array<{ workflowId: string; nodeId: string }>
  credentials: Array<{ key: string; refId: string; kind?: string }>
}

export interface WorkflowConfigDefinition {
  constants: Record<string, string>
  secretRefs: Array<{ key: string; refId: string; kind?: string }>
}

/** Immutable executable artifact created by every publish operation. */
export interface WorkflowVersion {
  id: string
  accountId: string
  workflowId: string
  sequence: number
  definition: VisualWorkflow
  interface: WorkflowInterface
  dependencyManifest: WorkflowDependencyManifest
  configDefinition: WorkflowConfigDefinition
  digest: string
  name: string
  description?: string
  createdAt: number
  createdBy?: string
}

/** Atomic pointer selecting the version executed in one environment. */
export interface WorkflowDeployment {
  id: string
  accountId: string
  workflowId: string
  environment: WorkflowEnvironment
  versionId: string
  revision: number
  status: "active" | "disabled"
  createdAt: number
  updatedAt: number
  updatedBy?: string
}

export type WorkflowEntrypoint =
  "http" | "mcp" | "portal" | "trigger" | "skill" | "agent-tool" | "subworkflow" | "desktop" | "cli"

export interface WorkflowInvocation {
  id: string
  accountId: string
  entrypoint: WorkflowEntrypoint
  caller: string
  deploymentId: string
  deploymentRevision: number
  versionId: string
  idempotencyKey?: string
  runId?: string
  status: "admitted" | "running" | "completed" | "rejected"
  dependencyLock?: WorkflowDependencyLock
  createdAt: number
  updatedAt: number
}

export interface WorkflowDependencyBinding {
  workflowId: string
  versionId: string
  deploymentId: string
  deploymentRevision: number
  dependencyLock?: WorkflowDependencyLock
}

/** Versions resolved before a formal run is admitted. Keys are parent node ids. */
export interface WorkflowDependencyLock {
  workflows: Record<string, WorkflowDependencyBinding>
  indexes: Record<string, string>
}

export interface WorkflowExecutionBinding {
  invocationId?: string
  versionId: string
  deploymentId: string
  deploymentRevision: number
  entrypoint: WorkflowEntrypoint
  caller: string
  idempotencyKey?: string
  dependencyLock?: WorkflowDependencyLock
}
