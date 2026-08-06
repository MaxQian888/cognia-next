import type {
  WorkflowConfigDefinition,
  WorkflowDependencyManifest,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type { VisualWorkflow, WorkflowInterface } from "@/types/workflow/visual"

const FNV_PRIME_32 = 0x01000193
const DIGEST_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash
}

/** Stable content identity; it detects drift but is not an authenticity signature. */
export function workflowVersionDigest(value: unknown): string {
  const canonical = canonicalize(value)
  const digest = DIGEST_SEEDS.map((seed) => fnv1a32(canonical, seed).toString(16).padStart(8, "0"))
  return `wfv1:${digest.join("")}`
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T
}

export function deriveWorkflowDependencyManifest(
  workflow: VisualWorkflow
): WorkflowDependencyManifest {
  const nodeTypes = new Map<string, WorkflowDependencyManifest["nodeTypes"][number]>()
  const workflows = new Map<string, WorkflowDependencyManifest["workflows"][number]>()

  for (const node of workflow.nodes) {
    nodeTypes.set(`${node.type}@${node.typeVersion}`, {
      kind: node.type,
      typeVersion: node.typeVersion,
    })
    const params = (node.data?.params ?? {}) as Record<string, unknown>
    const directWorkflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : ""
    const target =
      params.target && typeof params.target === "object"
        ? (params.target as Record<string, unknown>)
        : undefined
    const targetWorkflowId = typeof target?.workflowId === "string" ? target.workflowId.trim() : ""
    const workflowId = directWorkflowId || targetWorkflowId
    if (workflowId) workflows.set(`${node.id}:${workflowId}`, { workflowId, nodeId: node.id })
  }

  const credentials = Object.entries(workflow.credentials ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, ref]) => ({ key, refId: ref.id, ...(ref.kind ? { kind: ref.kind } : {}) }))

  return {
    nodeTypes: [...nodeTypes.values()].sort((left, right) =>
      `${left.kind}@${left.typeVersion}`.localeCompare(`${right.kind}@${right.typeVersion}`)
    ),
    workflows: [...workflows.values()].sort((left, right) =>
      `${left.nodeId}:${left.workflowId}`.localeCompare(`${right.nodeId}:${right.workflowId}`)
    ),
    credentials,
  }
}

export function createWorkflowVersion(input: {
  workflow: VisualWorkflow
  workflowInterface: WorkflowInterface
  accountId: string
  sequence: number
  createdAt: number
  createdBy?: string
}): WorkflowVersion {
  const definition = cloneSerializable({
    ...input.workflow,
    interface: input.workflowInterface,
    published: undefined,
    pinData: undefined,
  })
  const dependencyManifest = deriveWorkflowDependencyManifest(definition)
  const configDefinition: WorkflowConfigDefinition = {
    constants: { ...(definition.variables ?? {}) },
    secretRefs: dependencyManifest.credentials.map(({ key, refId, kind }) => ({
      key,
      refId,
      ...(kind ? { kind } : {}),
    })),
  }
  const digest = workflowVersionDigest({
    definition,
    interface: input.workflowInterface,
    dependencyManifest,
    configDefinition,
  })

  return {
    id: `wfv_${input.workflow.id}_${input.sequence}`,
    accountId: input.accountId,
    workflowId: input.workflow.id,
    sequence: input.sequence,
    definition,
    interface: cloneSerializable(input.workflowInterface),
    dependencyManifest,
    configDefinition,
    digest,
    name: input.workflow.name,
    description: input.workflow.description,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
  }
}

export function workflowDeploymentId(
  accountId: string,
  workflowId: string,
  environment: string
): string {
  return `wfd_${workflowVersionDigest({ accountId, workflowId, environment }).slice("wfv1:".length)}`
}
