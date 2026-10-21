/** Portable workflow-editor value types and pure authoring helpers. */

import type {
  ProposalOp,
  ProposalOpCount,
} from "@cognia/plugin-contract/lib/workflow/editor/proposal-types"
import type {
  VisualWorkflow,
  WorkflowNodeData,
  WorkflowNodeKind,
} from "@cognia/plugin-contract/types/workflow/visual"

export type {
  ProposalOp,
  ProposalOpCount,
} from "@cognia/plugin-contract/lib/workflow/editor/proposal-types"
export type { ProposalPayload } from "@cognia/plugin-contract/lib/workflow/editor/proposal-store"
export type {
  CopilotI18n,
  CopilotSlotValues,
  CopilotTemplateSlot,
  WorkflowCopilotTemplate,
} from "@cognia/plugin-contract/lib/workflow/copilot-templates/types"
export type {
  MaterializeFailure,
  MaterializeResult,
  MaterializeSuccess,
} from "@cognia/plugin-contract/lib/workflow/copilot-templates/index"
export type {
  ExplainedLastRun,
  ExplainedSeverity,
  ExplainedValidation,
} from "@cognia/plugin-contract/lib/workflow/runtime/error-explainer"

export const ELK_DIRECTIONS = {
  LR: "RIGHT",
  RL: "LEFT",
  TB: "DOWN",
  BT: "UP",
} as const

export type AutoLayoutDirection = keyof typeof ELK_DIRECTIONS

export const KNOWN_PROPOSAL_OP_TYPES: ReadonlySet<string> = new Set([
  "add_node",
  "remove_node",
  "connect_edge",
  "disconnect_edge",
  "configure_node",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value: unknown, index: number, field: string): string | { error: string } {
  return typeof value === "string" && value.length > 0
    ? value
    : { error: `op ${index}: ${field} is required` }
}

/** Validate one proposal operation without importing the host's Zod graph. */
export function coerceProposalOp(raw: unknown, index: number): ProposalOp | string {
  if (!isRecord(raw)) return `op ${index}: must be an object`
  const type = raw.type
  if (typeof type !== "string" || !KNOWN_PROPOSAL_OP_TYPES.has(type)) {
    return `op ${index}: unknown op type "${String(type)}"`
  }

  if (type === "add_node") {
    const nodeId = requiredString(raw.nodeId, index, "nodeId")
    if (typeof nodeId !== "string") return nodeId.error
    const kind = requiredString(raw.kind, index, "kind")
    if (typeof kind !== "string") return kind.error
    if (!isRecord(raw.position)) return `op ${index}: position is required`
    if (typeof raw.position.x !== "number") return `op ${index}: x is invalid`
    if (typeof raw.position.y !== "number") return `op ${index}: y is invalid`
    if (
      raw.typeVersion !== undefined &&
      (!Number.isInteger(raw.typeVersion) || (raw.typeVersion as number) < 1)
    ) {
      return `op ${index}: typeVersion is invalid`
    }
    if (raw.data !== undefined && !isRecord(raw.data)) return `op ${index}: data is invalid`
    return {
      type,
      nodeId,
      kind: kind as WorkflowNodeKind,
      position: { x: raw.position.x, y: raw.position.y },
      ...(typeof raw.typeVersion === "number" ? { typeVersion: raw.typeVersion } : {}),
      ...(raw.data ? { data: raw.data } : {}),
    } as ProposalOp
  }

  if (type === "remove_node") {
    const nodeId = requiredString(raw.nodeId, index, "nodeId")
    return typeof nodeId === "string" ? { type, nodeId } : nodeId.error
  }

  if (type === "connect_edge") {
    const edgeId = requiredString(raw.edgeId, index, "edgeId")
    if (typeof edgeId !== "string") return edgeId.error
    const source = requiredString(raw.source, index, "source")
    if (typeof source !== "string") return source.error
    const target = requiredString(raw.target, index, "target")
    if (typeof target !== "string") return target.error
    for (const field of ["sourceHandle", "targetHandle", "label"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") {
        return `op ${index}: ${field} is invalid`
      }
    }
    return {
      type,
      edgeId,
      source,
      target,
      ...(typeof raw.sourceHandle === "string" ? { sourceHandle: raw.sourceHandle } : {}),
      ...(typeof raw.targetHandle === "string" ? { targetHandle: raw.targetHandle } : {}),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    }
  }

  if (type === "disconnect_edge") {
    const edgeId = requiredString(raw.edgeId, index, "edgeId")
    return typeof edgeId === "string" ? { type, edgeId } : edgeId.error
  }

  const nodeId = requiredString(raw.nodeId, index, "nodeId")
  if (typeof nodeId !== "string") return nodeId.error
  if (!isRecord(raw.patch)) return `op ${index}: patch is required`
  return { type: "configure_node", nodeId, patch: raw.patch }
}

export function summarizeOps(ops: ReadonlyArray<ProposalOp>): ProposalOpCount {
  const count: ProposalOpCount = { add: 0, remove: 0, connect: 0, disconnect: 0, configure: 0 }
  for (const op of ops) {
    if (op.type === "add_node") count.add += 1
    else if (op.type === "remove_node") count.remove += 1
    else if (op.type === "connect_edge") count.connect += 1
    else if (op.type === "disconnect_edge") count.disconnect += 1
    else count.configure += 1
  }
  return count
}

function sanitizeForId(raw: string): string {
  return (
    raw
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()
      .slice(0, 24) || "node"
  )
}

/**
 * Convert a VisualWorkflow (produced by a template's `build(slots)`) into an
 * ordered list of `add_node` + `connect_edge` ops for the proposal store.
 *
 * Every node is re-id'd so the proposal never collides with the current graph
 * (`existing`) or with itself; edges are translated through the same map, and
 * an edge whose endpoint the workflow does not contain is dropped so the user
 * can still accept the partial proposal. Added nodes are marked
 * `authoredBy: "ai"`. Shared by the workflow editor's template tab and the
 * workflow-ai plugin's `wf_apply_template` tool.
 */
export function templateToProposalOps(
  workflow: VisualWorkflow,
  existing: { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> },
  reserveId: () => string
): { ops: ProposalOp[]; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {}
  const reservedNodes = new Set<string>(existing.nodeIds)
  const reservedEdges = new Set<string>(existing.edgeIds)

  function pickNodeId(seed: string): string {
    let id = `n_${seed}_${reserveId()}`
    while (reservedNodes.has(id)) id = `n_${seed}_${reserveId()}`
    reservedNodes.add(id)
    return id
  }
  function pickEdgeId(): string {
    let id = `e_${reserveId()}`
    while (reservedEdges.has(id)) id = `e_${reserveId()}`
    reservedEdges.add(id)
    return id
  }

  const ops: ProposalOp[] = []

  for (const node of workflow.nodes) {
    const realId = pickNodeId(sanitizeForId(node.id))
    idMap[node.id] = realId
    const data: Partial<WorkflowNodeData> = {
      label: node.data.label,
      params: node.data.params,
      notes: node.data.notes,
      credentialRefs: node.data.credentialRefs,
      disabled: node.data.disabled,
      authoredBy: "ai",
    }
    ops.push({
      type: "add_node",
      nodeId: realId,
      kind: node.type as WorkflowNodeKind,
      typeVersion: node.typeVersion,
      position: node.position,
      data,
    })
  }

  for (const edge of workflow.edges) {
    const realSource = idMap[edge.source]
    const realTarget = idMap[edge.target]
    if (!realSource || !realTarget) continue
    ops.push({
      type: "connect_edge",
      edgeId: pickEdgeId(),
      source: realSource,
      target: realTarget,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      label: edge.label,
    })
  }

  return { ops, idMap }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "selected" && key !== "measured" && key !== "dragging")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  )
}

/** Stable semantic graph token used as the proposal compare-and-swap revision. */
export function workflowEditorRevision(state: {
  nodes: ReadonlyArray<{ id: string } & Record<string, unknown>>
  edges: ReadonlyArray<{ id: string } & Record<string, unknown>>
}): string {
  const project = (value: Record<string, unknown>, keys: string[]) =>
    stableValue(Object.fromEntries(keys.map((key) => [key, value[key]])))
  const graph = {
    nodes: [...state.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) =>
        project(node as Record<string, unknown>, [
          "id",
          "type",
          "position",
          "parentId",
          "extent",
          "data",
        ])
      ),
    edges: [...state.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) =>
        project(edge as Record<string, unknown>, [
          "id",
          "source",
          "target",
          "sourceHandle",
          "targetHandle",
          "type",
          "label",
          "data",
        ])
      ),
  }
  const serialized = JSON.stringify(graph)
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `wf:${(hash >>> 0).toString(16).padStart(8, "0")}`
}
