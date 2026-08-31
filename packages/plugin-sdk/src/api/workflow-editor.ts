/** Portable workflow-editor value types and pure authoring helpers. */

import type { ProposalOp, ProposalOpCount } from "@/lib/workflow/editor/proposal-types"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export type { ProposalOp, ProposalOpCount } from "@/lib/workflow/editor/proposal-types"
export type { ProposalPayload } from "@/lib/workflow/editor/proposal-store"
export type {
  CopilotI18n,
  CopilotSlotValues,
  CopilotTemplateSlot,
  MaterializeFailure,
  MaterializeResult,
  MaterializeSuccess,
  WorkflowCopilotTemplate,
} from "@/lib/workflow/copilot-templates"
export type {
  ExplainedLastRun,
  ExplainedSeverity,
  ExplainedValidation,
} from "@/lib/workflow/runtime/error-explainer"

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
