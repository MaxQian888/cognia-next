import { nanoid } from "nanoid"
import {
  WORKFLOW_NODE_GROUP_PAYLOAD_KIND,
  type TemplateDefinitionEnvelope,
  type WorkflowNodeGroupDefinition,
} from "@cognia/plugin-sdk/templates"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "@/types/workflow/visual"
import {
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "@/lib/workflow/editor/react-flow-converter"

export const MAX_WORKFLOW_NODE_GROUP_NODES = 256
export const MAX_WORKFLOW_NODE_GROUP_EDGES = 1024

export interface WorkflowNodeGroupIssue {
  code:
    | "definition.kind"
    | "group.empty"
    | "group.too-large"
    | "node.invalid"
    | "node.duplicate-id"
    | "node.parent"
    | "node.parent-cycle"
    | "edge.invalid"
    | "edge.duplicate-id"
    | "edge.endpoint"
  path: string
  message: string
}

export interface WorkflowNodeGroupValidation {
  ok: boolean
  issues: WorkflowNodeGroupIssue[]
}

export interface MaterializedWorkflowNodeGroup {
  groupId: string
  nodeIds: string[]
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
}

export function isWorkflowNodeGroupDefinition(
  definition: TemplateDefinitionEnvelope
): definition is WorkflowNodeGroupDefinition {
  if (definition.domain !== "workflow") return false
  const payload = definition.payload
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.kind === WORKFLOW_NODE_GROUP_PAYLOAD_KIND &&
    Array.isArray(payload.nodes) &&
    Array.isArray(payload.edges)
  )
}

export function validateWorkflowNodeGroup(
  definition: TemplateDefinitionEnvelope
): WorkflowNodeGroupValidation {
  const issues: WorkflowNodeGroupIssue[] = []
  if (!isWorkflowNodeGroupDefinition(definition)) {
    return {
      ok: false,
      issues: [
        {
          code: "definition.kind",
          path: "payload.kind",
          message: `Expected ${WORKFLOW_NODE_GROUP_PAYLOAD_KIND}`,
        },
      ],
    }
  }

  const { nodes, edges } = definition.payload
  if (nodes.length === 0) {
    issues.push({
      code: "group.empty",
      path: "payload.nodes",
      message: "A workflow node group must contain at least one node",
    })
  }
  if (
    nodes.length > MAX_WORKFLOW_NODE_GROUP_NODES ||
    edges.length > MAX_WORKFLOW_NODE_GROUP_EDGES
  ) {
    issues.push({
      code: "group.too-large",
      path: "payload",
      message: `A workflow node group is limited to ${MAX_WORKFLOW_NODE_GROUP_NODES} nodes and ${MAX_WORKFLOW_NODE_GROUP_EDGES} edges`,
    })
  }

  const nodeIds = new Set<string>()
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const path = `payload.nodes[${index}]`
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      typeof node.type !== "string" ||
      !node.type ||
      !Number.isInteger(node.typeVersion) ||
      node.typeVersion < 1 ||
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y) ||
      typeof node.data?.label !== "string"
    ) {
      issues.push({ code: "node.invalid", path, message: "Node shape is invalid" })
      continue
    }
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "node.duplicate-id",
        path: `${path}.id`,
        message: `Duplicate node id "${node.id}"`,
      })
    }
    nodeIds.add(node.id)
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const parentById = new Map<string, string>()
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (!node.parentId) continue
    const parent = nodeById.get(node.parentId)
    const parentIsContainer =
      parent?.type === "flow.loop"
        ? parent.typeVersion >= 2
        : parent?.type === "annotation.group" && parent.typeVersion >= 2
    if (node.parentId === node.id || !parent || !parentIsContainer) {
      issues.push({
        code: "node.parent",
        path: `payload.nodes[${index}].parentId`,
        message: `Parent "${node.parentId}" must be a v2 loop or annotation group container`,
      })
      continue
    }
    parentById.set(node.id, node.parentId)
  }
  for (const node of nodes) {
    const seen = new Set<string>()
    let cursor: string | undefined = node.id
    while (cursor && parentById.has(cursor)) {
      if (seen.has(cursor)) {
        issues.push({
          code: "node.parent-cycle",
          path: `payload.nodes.${node.id}.parentId`,
          message: `Parent cycle contains "${cursor}"`,
        })
        break
      }
      seen.add(cursor)
      cursor = parentById.get(cursor)
    }
  }

  const edgeIds = new Set<string>()
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]
    const path = `payload.edges[${index}]`
    if (
      !edge ||
      typeof edge.id !== "string" ||
      !edge.id ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string"
    ) {
      issues.push({ code: "edge.invalid", path, message: "Edge shape is invalid" })
      continue
    }
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "edge.duplicate-id",
        path: `${path}.id`,
        message: `Duplicate edge id "${edge.id}"`,
      })
    }
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({
        code: "edge.endpoint",
        path,
        message: `Edge "${edge.id}" references a node outside the group`,
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

const DEFAULT_NODE_SIZE = { width: 240, height: 80 }
const FRAME_PADDING = { left: 32, right: 32, top: 48, bottom: 32 }

function asVisualWorkflow(definition: WorkflowNodeGroupDefinition): VisualWorkflow {
  return {
    id: definition.id,
    schemaVersion: 1,
    name: definition.metadata.name,
    description: definition.metadata.description,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    nodes: definition.payload.nodes as unknown as WorkflowNode[],
    edges: definition.payload.edges as unknown as WorkflowEdge[],
    settings: DEFAULT_WORKFLOW_SETTINGS,
  }
}

/**
 * Expand a portable node-group template into fresh React Flow entities. This is
 * linear in nodes + edges and performs no store writes; callers can validate
 * everything and commit the returned arrays in one undo entry.
 */
export function materializeWorkflowNodeGroup(
  definition: WorkflowNodeGroupDefinition,
  position: { x: number; y: number },
  sequence: () => string = () => nanoid(8)
): MaterializedWorkflowNodeGroup {
  const validation = validateWorkflowNodeGroup(definition)
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join("; "))
  }

  const converted = workflowToReactFlow(asVisualWorkflow(definition))
  const topLevel = converted.nodes.filter((node) => !node.parentId)
  const minX = Math.min(...topLevel.map((node) => node.position.x))
  const minY = Math.min(...topLevel.map((node) => node.position.y))
  const maxX = Math.max(
    ...topLevel.map((node) => node.position.x + (node.width ?? DEFAULT_NODE_SIZE.width))
  )
  const maxY = Math.max(
    ...topLevel.map((node) => node.position.y + (node.height ?? DEFAULT_NODE_SIZE.height))
  )
  const width = maxX - minX + FRAME_PADDING.left + FRAME_PADDING.right
  const height = maxY - minY + FRAME_PADDING.top + FRAME_PADDING.bottom

  const groupId = `n_${sequence()}`
  const idMap = new Map<string, string>()
  for (const node of converted.nodes) idMap.set(node.id, `n_${sequence()}`)

  const group: RFWorkflowNode = {
    id: groupId,
    type: "groupContainer",
    position,
    width,
    height,
    data: {
      label: definition.metadata.name,
      kind: "annotation.group",
      typeVersion: 2,
      params: { title: definition.metadata.name, width, height },
    },
  }
  const nodes: RFWorkflowNode[] = converted.nodes.map((node) => {
    const mappedParent = node.parentId ? idMap.get(node.parentId) : groupId
    return {
      ...node,
      id: idMap.get(node.id)!,
      parentId: mappedParent,
      extent: "parent",
      position: node.parentId
        ? node.position
        : {
            x: node.position.x - minX + FRAME_PADDING.left,
            y: node.position.y - minY + FRAME_PADDING.top,
          },
      selected: false,
      dragging: false,
    }
  })
  const edges: RFWorkflowEdge[] = converted.edges.map((edge) => ({
    ...edge,
    id: `e_${sequence()}`,
    source: idMap.get(edge.source)!,
    target: idMap.get(edge.target)!,
    selected: false,
  }))

  return {
    groupId,
    nodeIds: nodes.map((node) => node.id),
    nodes: [group, ...nodes],
    edges,
  }
}
