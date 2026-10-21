/**
 * The plugin contract's share of `lib/workflow/editor/react-flow-converter.ts`, which re-exports these.
 */
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react"
import type { WorkflowEdge, WorkflowNode, WorkflowNodeData } from "../../../types/workflow/visual"

/**
 * React Flow node payload. The `data` slot extends WorkflowNodeData (with its
 * index signature) and tacks on `kind` + `typeVersion` so the renderer can
 * dispatch on the kind without an extra lookup.
 */
export interface RFWorkflowData extends WorkflowNodeData {
  kind: WorkflowNode["type"]
  typeVersion: number
}

export type RFWorkflowNode = RFNode<
  RFWorkflowData,
  "workflowNode" | "loopContainer" | "groupContainer"
>

export interface RFWorkflowEdgeData extends Record<string, unknown> {
  workflowKind?: NonNullable<WorkflowEdge["data"]>["kind"]
}

export type RFWorkflowEdge = RFEdge<RFWorkflowEdgeData>
