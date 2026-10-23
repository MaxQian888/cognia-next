/**
 * The plugin contract's share of `lib/workflow/editor/proposal-types.ts`, which re-exports these.
 */
import type { WorkflowNodeData, WorkflowNodeKind } from "../../../types/workflow/visual"

export interface ProposalOpAddNode {
  type: "add_node"
  nodeId: string
  kind: WorkflowNodeKind
  /** Preserve an imported/template node version; omit for the current authoring default. */
  typeVersion?: number
  position: { x: number; y: number }
  data?: Partial<WorkflowNodeData>
}

export interface ProposalOpRemoveNode {
  type: "remove_node"
  nodeId: string
}

export interface ProposalOpConnectEdge {
  type: "connect_edge"
  edgeId: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
}

export interface ProposalOpDisconnectEdge {
  type: "disconnect_edge"
  edgeId: string
}

export interface ProposalOpConfigureNode {
  type: "configure_node"
  nodeId: string
  patch: Partial<WorkflowNodeData>
}

export type ProposalOp =
  | ProposalOpAddNode
  | ProposalOpRemoveNode
  | ProposalOpConnectEdge
  | ProposalOpDisconnectEdge
  | ProposalOpConfigureNode

/** Aggregate counts surfaced on the proposal card and tool result. */
export interface ProposalOpCount {
  add: number
  remove: number
  connect: number
  disconnect: number
  configure: number
}
