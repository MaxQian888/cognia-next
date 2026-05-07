/**
 * Round-trip conversion between the visual workflow definition (Dexie/JSON
 * shape) and React Flow's node/edge shapes.
 *
 * The conversion is intentionally one-to-one: we don't rename fields or
 * reshape positions. React Flow v12 stores arbitrary `data` on nodes and
 * edges, so the workflow's `WorkflowNodeData` and `WorkflowEdge.data` survive
 * the trip without flattening.
 */

import type { Edge as RFEdge, Node as RFNode, Viewport } from "@xyflow/react"
import type {
  VisualWorkflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowViewport,
} from "@/types/workflow/visual"

/**
 * React Flow node payload. The `data` slot extends WorkflowNodeData (with its
 * index signature) and tacks on `kind` + `typeVersion` so the renderer can
 * dispatch on the kind without an extra lookup.
 */
export interface RFWorkflowData extends WorkflowNodeData {
  kind: WorkflowNode["type"]
  typeVersion: number
}

export type RFWorkflowNode = RFNode<RFWorkflowData, "workflowNode">

export interface RFWorkflowEdgeData extends Record<string, unknown> {
  workflowKind?: NonNullable<WorkflowEdge["data"]>["kind"]
}

export type RFWorkflowEdge = RFEdge<RFWorkflowEdgeData>

export interface ConvertedWorkflow {
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
  viewport: Viewport
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

/**
 * Convert a `VisualWorkflow` into React Flow's nodes + edges + viewport.
 * The `kind` and `typeVersion` are flattened into node `data` so the custom
 * node renderer can dispatch on them without an extra lookup table.
 */
export function workflowToReactFlow(wf: VisualWorkflow): ConvertedWorkflow {
  const nodes: RFWorkflowNode[] = wf.nodes.map((n) => ({
    id: n.id,
    type: "workflowNode" as const,
    position: { x: n.position.x, y: n.position.y },
    data: {
      ...n.data,
      kind: n.type,
      typeVersion: n.typeVersion,
    },
    width: n.width,
    height: n.height,
  }))

  const edges: RFWorkflowEdge[] = wf.edges.map((e) => {
    const edge: RFWorkflowEdge = {
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.data?.kind === "conditional" ? "conditional" : "default",
    }
    if (e.sourceHandle !== undefined) edge.sourceHandle = e.sourceHandle
    if (e.targetHandle !== undefined) edge.targetHandle = e.targetHandle
    if (e.label !== undefined) edge.label = e.label
    if (e.data) edge.data = { workflowKind: e.data.kind }
    return edge
  })

  return {
    nodes,
    edges,
    viewport: wf.viewport
      ? { x: wf.viewport.x, y: wf.viewport.y, zoom: wf.viewport.zoom }
      : DEFAULT_VIEWPORT,
  }
}

/**
 * Inverse of `workflowToReactFlow`. Pulls React Flow nodes/edges/viewport
 * back into the persisted shape so the editor's "Save" path can write to
 * Dexie via `replaceWorkflow`.
 */
export function reactFlowToWorkflow(
  base: VisualWorkflow,
  nodes: RFWorkflowNode[],
  edges: RFWorkflowEdge[],
  viewport: Viewport
): VisualWorkflow {
  const newNodes: WorkflowNode[] = nodes.map((n) => {
    const { kind, typeVersion, ...data } = (n.data ?? {}) as WorkflowNodeData & {
      kind: WorkflowNode["type"]
      typeVersion: number
    }
    return {
      id: n.id,
      type: kind,
      typeVersion,
      position: { x: n.position.x, y: n.position.y },
      data: {
        label: data.label,
        params: data.params,
        notes: data.notes,
        credentialRefs: data.credentialRefs,
        disabled: data.disabled,
      },
      width: typeof n.width === "number" ? n.width : undefined,
      height: typeof n.height === "number" ? n.height : undefined,
    }
  })

  const newEdges: WorkflowEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? undefined,
    target: e.target,
    targetHandle: e.targetHandle ?? undefined,
    label: typeof e.label === "string" ? e.label : undefined,
    data: e.data?.workflowKind ? { kind: e.data.workflowKind } : undefined,
  }))

  const next: VisualWorkflow = {
    ...base,
    nodes: newNodes,
    edges: newEdges,
    viewport: toWorkflowViewport(viewport),
  }
  return next
}

function toWorkflowViewport(v: Viewport): WorkflowViewport {
  return { x: v.x, y: v.y, zoom: v.zoom }
}
