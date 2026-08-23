import type {
  WorkflowNodeGroupDefinition,
  WorkflowNodeGroupInterface,
} from "@cognia/plugin-sdk/templates"
import type { RFWorkflowEdge, RFWorkflowNode } from "@/lib/workflow/editor/react-flow-converter"
import { materializeWorkflowNodeGroup } from "./materialize"

interface NodeGroupInstanceRef {
  definitionId: string
  version: string | null
  revision: number
  contentHash: string
  sourceNodeIds: Record<string, string>
  interface?: WorkflowNodeGroupInterface
}

export interface NodeGroupUpgradePlan {
  groupId: string
  definitionId: string
  fromVersion: string | null
  toVersion: string | null
  compatible: boolean
  blockers: string[]
  addedNodeIds: string[]
  removedNodeIds: string[]
  changedNodeIds: string[]
  addedPortIds: string[]
  removedPortIds: string[]
}

export function readNodeGroupInstance(
  node: RFWorkflowNode | undefined
): NodeGroupInstanceRef | null {
  if (node?.data.kind !== "annotation.group") return null
  const params = node.data.params
  if (!params || typeof params !== "object") return null
  const value = (params as Record<string, unknown>).nodeGroupInstance
  if (!value || typeof value !== "object") return null
  const ref = value as Partial<NodeGroupInstanceRef>
  if (
    typeof ref.definitionId !== "string" ||
    typeof ref.contentHash !== "string" ||
    !ref.sourceNodeIds ||
    typeof ref.sourceNodeIds !== "object"
  ) {
    return null
  }
  return ref as NodeGroupInstanceRef
}

function portIds(value: WorkflowNodeGroupInterface | undefined): Set<string> {
  return new Set([...(value?.inputs ?? []), ...(value?.outputs ?? [])].map((port) => port.id))
}

export function planNodeGroupUpgrade(
  nodes: RFWorkflowNode[],
  edges: RFWorkflowEdge[],
  groupId: string,
  target: WorkflowNodeGroupDefinition
): NodeGroupUpgradePlan {
  const group = nodes.find((node) => node.id === groupId)
  const instance = readNodeGroupInstance(group)
  if (!instance) throw new Error(`Node ${groupId} is not a version-pinned Node Group instance`)
  if (instance.definitionId !== target.id) {
    throw new Error(`Node Group ${groupId} pins ${instance.definitionId}, not ${target.id}`)
  }
  const currentStableIds = new Set(Object.keys(instance.sourceNodeIds))
  const targetById = new Map(target.payload.nodes.map((node) => [node.id, node]))
  const currentNodeById = new Map(nodes.map((node) => [node.id, node]))
  const inverse = new Map(
    Object.entries(instance.sourceNodeIds).map(([stableId, instanceId]) => [instanceId, stableId])
  )
  const addedNodeIds = [...targetById.keys()].filter((id) => !currentStableIds.has(id))
  const removedNodeIds = [...currentStableIds].filter((id) => !targetById.has(id))
  const changedNodeIds = [...currentStableIds].filter((id) => {
    const targetNode = targetById.get(id)
    const currentNode = currentNodeById.get(instance.sourceNodeIds[id])
    return Boolean(
      targetNode &&
      currentNode &&
      (currentNode.data.kind !== targetNode.type ||
        currentNode.data.typeVersion !== targetNode.typeVersion ||
        JSON.stringify(currentNode.data.params) !== JSON.stringify(targetNode.data.params ?? {}))
    )
  })
  const blockers: string[] = []
  for (const edge of edges) {
    const sourceStable = inverse.get(edge.source)
    const targetStable = inverse.get(edge.target)
    if (sourceStable && !targetStable && !targetById.has(sourceStable)) {
      blockers.push(`External edge ${edge.id} uses removed source node ${sourceStable}`)
    }
    if (targetStable && !sourceStable && !targetById.has(targetStable)) {
      blockers.push(`External edge ${edge.id} uses removed target node ${targetStable}`)
    }
  }
  const currentPorts = portIds(instance.interface)
  const targetPorts = portIds(target.payload.interface)
  const addedPortIds = [...targetPorts].filter((id) => !currentPorts.has(id))
  const removedPortIds = [...currentPorts].filter((id) => !targetPorts.has(id))
  return {
    groupId,
    definitionId: target.id,
    fromVersion: instance.version,
    toVersion: target.version,
    compatible: blockers.length === 0,
    blockers,
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    addedPortIds,
    removedPortIds,
  }
}

export function applyNodeGroupUpgrade(
  nodes: RFWorkflowNode[],
  edges: RFWorkflowEdge[],
  groupId: string,
  target: WorkflowNodeGroupDefinition,
  sequence: () => string = () => crypto.randomUUID()
): { nodes: RFWorkflowNode[]; edges: RFWorkflowEdge[]; plan: NodeGroupUpgradePlan } {
  const plan = planNodeGroupUpgrade(nodes, edges, groupId, target)
  if (!plan.compatible) {
    throw new Error(`Node Group upgrade is not compatible: ${plan.blockers.join("; ")}`)
  }
  const currentGroup = nodes.find((node) => node.id === groupId)!
  const current = readNodeGroupInstance(currentGroup)!
  const materialized = materializeWorkflowNodeGroup(target, currentGroup.position, sequence)
  const generatedGroup = materialized.nodes[0]
  const generated = readNodeGroupInstance(generatedGroup)!
  const desiredStableMap = Object.fromEntries(
    Object.entries(generated.sourceNodeIds).map(([stableId, generatedId]) => [
      stableId,
      current.sourceNodeIds[stableId] ?? generatedId,
    ])
  )
  const generatedToDesired = new Map<string, string>([[materialized.groupId, groupId]])
  for (const [stableId, generatedId] of Object.entries(generated.sourceNodeIds)) {
    generatedToDesired.set(generatedId, desiredStableMap[stableId])
  }
  const nextGroup: RFWorkflowNode = {
    ...generatedGroup,
    id: groupId,
    position: currentGroup.position,
    selected: currentGroup.selected,
    data: {
      ...generatedGroup.data,
      params: {
        ...(generatedGroup.data.params as Record<string, unknown>),
        nodeGroupInstance: {
          ...generated,
          sourceNodeIds: desiredStableMap,
          interface: target.payload.interface,
        },
      },
    },
  }
  const nextChildren = materialized.nodes.slice(1).map((node) => ({
    ...node,
    id: generatedToDesired.get(node.id)!,
    parentId: node.parentId ? generatedToDesired.get(node.parentId) : node.parentId,
  }))
  const currentChildIds = new Set(Object.values(current.sourceNodeIds))
  const inverseCurrent = new Map(
    Object.entries(current.sourceNodeIds).map(([stableId, instanceId]) => [instanceId, stableId])
  )
  const retainedEdges: RFWorkflowEdge[] = []
  for (const edge of edges) {
    const sourceInside = currentChildIds.has(edge.source)
    const targetInside = currentChildIds.has(edge.target)
    if (sourceInside && targetInside) continue
    retainedEdges.push({
      ...edge,
      source: sourceInside ? desiredStableMap[inverseCurrent.get(edge.source)!] : edge.source,
      target: targetInside ? desiredStableMap[inverseCurrent.get(edge.target)!] : edge.target,
    })
  }
  const internalEdges = materialized.edges.map((edge) => ({
    ...edge,
    source: generatedToDesired.get(edge.source)!,
    target: generatedToDesired.get(edge.target)!,
  }))
  return {
    nodes: [
      ...nodes.filter((node) => node.id !== groupId && !currentChildIds.has(node.id)),
      nextGroup,
      ...nextChildren,
    ],
    edges: [...retainedEdges, ...internalEdges],
    plan,
  }
}
