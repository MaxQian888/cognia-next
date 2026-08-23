import {
  WORKFLOW_NODE_GROUP_PAYLOAD_KIND,
  type WorkflowNodeGroupDefinition,
  type WorkflowNodeGroupEdge,
  type WorkflowNodeGroupInterface,
  type WorkflowNodeGroupNode,
} from "@cognia/plugin-sdk/templates"
import { TemplateCatalog, templateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition, type TemplateJson } from "@/lib/templates/contracts"
import type { TemplateRepository } from "@/lib/templates/repository"
import { DexieTemplateRepository } from "@/lib/db/template-platform"
import { parseExpression, tokenize } from "@/lib/workflow/runtime/expression"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

const FORBIDDEN_KEYS = new Set(["apiKey", "token", "secret", "credentialId", "localPath"])

export interface InferredNodeGroupSelection {
  nodes: WorkflowNodeGroupNode[]
  edges: WorkflowNodeGroupEdge[]
  interface: WorkflowNodeGroupInterface
}

export interface CreateNodeGroupFromSelectionInput {
  workflow: VisualWorkflow
  selectedNodeIds: string[]
  id: string
  name: string
  description?: string
  version: string
  scope: "personal" | "workspace" | "portable-bundle"
  author?: string
  now?: number
}

interface NodeGroupAuthoringPorts {
  repository: TemplateRepository
  catalog: TemplateCatalog
}

function slug(input: string): string {
  const value = input
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!value) throw new Error("Node group id is required")
  return value
}

function walkValues(
  value: unknown,
  visit: (value: unknown, path: string) => void,
  path = "params"
): void {
  visit(value, path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValues(item, visit, `${path}[${index}]`))
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`${path}.${key} must be converted to a portable Secret reference`)
      }
      walkValues(nested, visit, `${path}.${key}`)
    }
  }
}

function portId(kind: string, nodeId: string, handleId?: string): string {
  return `${kind}:${nodeId}:${handleId || "default"}`
}

function toTemplateNode(node: WorkflowNode, minX: number, minY: number): WorkflowNodeGroupNode {
  return {
    id: node.id,
    type: node.type,
    typeVersion: node.typeVersion,
    position: { x: node.position.x - minX, y: node.position.y - minY },
    data: {
      label: node.data.label,
      params: (node.data.params ?? {}) as Record<string, TemplateJson>,
      ...(node.data.notes ? { notes: node.data.notes } : {}),
      ...(node.data.disabled ? { disabled: true } : {}),
      ...(node.data.locked ? { locked: true } : {}),
      ...(node.data.errorHandling
        ? { errorHandling: node.data.errorHandling as unknown as Record<string, TemplateJson> }
        : {}),
    },
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
  }
}

export function inferNodeGroupSelection(
  workflow: VisualWorkflow,
  selectedNodeIds: string[]
): InferredNodeGroupSelection {
  const selected = new Set(selectedNodeIds)
  if (selected.size === 0) throw new Error("Select at least one node to create a Node Group")
  const nodes = workflow.nodes.filter((node) => selected.has(node.id))
  if (nodes.length !== selected.size)
    throw new Error("Node Group selection contains an unknown node")
  for (const node of nodes) walkValues(node.data.params, () => undefined)

  const minX = Math.min(...nodes.map((node) => node.position.x))
  const minY = Math.min(...nodes.map((node) => node.position.y))
  const inputs = new Map<string, WorkflowNodeGroupInterface["inputs"][number]>()
  const outputs = new Map<string, WorkflowNodeGroupInterface["outputs"][number]>()
  const internalEdges: WorkflowNodeGroupEdge[] = []

  for (const edge of workflow.edges) {
    const sourceInside = selected.has(edge.source)
    const targetInside = selected.has(edge.target)
    if (sourceInside && targetInside) {
      internalEdges.push(edge)
    } else if (!sourceInside && targetInside) {
      const id = portId("input", edge.target, edge.targetHandle)
      inputs.set(id, {
        id,
        label: edge.targetHandle || "input",
        nodeId: edge.target,
        ...(edge.targetHandle ? { handleId: edge.targetHandle } : {}),
        schema: {},
        required: true,
        source: "edge",
      })
    } else if (sourceInside && !targetInside) {
      const id = portId("output", edge.source, edge.sourceHandle)
      outputs.set(id, {
        id,
        label: edge.sourceHandle || "output",
        nodeId: edge.source,
        ...(edge.sourceHandle ? { handleId: edge.sourceHandle } : {}),
        schema: {},
        required: false,
        source: "edge",
      })
    }
  }

  for (const node of nodes) {
    walkValues(node.data.params, (value, path) => {
      if (typeof value !== "string" || !value.includes("{{")) return
      for (const segment of parseExpression(value)) {
        if (segment.kind !== "expr") continue
        const head = tokenize(segment.value)[0]
        if (head?.kind === "node" || head?.kind === "nodes") {
          if (selected.has(head.id)) continue
          const id = portId("expression", node.id, head.id)
          inputs.set(id, {
            id,
            label: `${head.id} (${path})`,
            nodeId: node.id,
            handleId: head.id,
            schema: {},
            required: true,
            source: "expression",
          })
        } else if (head?.kind === "ident" && head.name === "$vars") {
          const variable = tokenize(segment.value)[1]
          if (variable?.kind !== "field" && variable?.kind !== "key") continue
          const id = `variable:${variable.name}`
          inputs.set(id, {
            id,
            label: variable.name,
            nodeId: node.id,
            schema: { type: "string" },
            required: workflow.variables?.[variable.name] === undefined,
            ...(workflow.variables?.[variable.name] !== undefined
              ? { defaultValue: workflow.variables[variable.name] }
              : {}),
            source: "variable",
          })
        }
      }
    })
  }

  return {
    nodes: nodes.map((node) => toTemplateNode(node, minX, minY)),
    edges: internalEdges,
    interface: { inputs: [...inputs.values()], outputs: [...outputs.values()] },
  }
}

export async function createNodeGroupFromSelection(
  input: CreateNodeGroupFromSelectionInput,
  ports: NodeGroupAuthoringPorts = {
    repository: new DexieTemplateRepository(),
    catalog: templateCatalog,
  }
): Promise<WorkflowNodeGroupDefinition> {
  const inferred = inferNodeGroupSelection(input.workflow, input.selectedNodeIds)
  const now = input.now ?? Date.now()
  const definition = (await createTemplateDefinition({
    id: slug(input.id),
    domain: "workflow",
    status: "published",
    revision: 1,
    version: input.version,
    metadata: {
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.author?.trim() ? { author: input.author.trim() } : {}),
      tags: ["node-group", input.scope],
    },
    payload: {
      kind: WORKFLOW_NODE_GROUP_PAYLOAD_KIND,
      nodes: inferred.nodes,
      edges: inferred.edges,
      interface: inferred.interface,
      distribution: { scope: input.scope },
    },
    inputs: inferred.interface.inputs.map((port) => ({
      id: port.id,
      label: port.label,
      required: port.required,
      kind: "string" as const,
      ...(typeof port.defaultValue === "string" ? { defaultValue: port.defaultValue } : {}),
    })),
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
    createdAt: now,
    updatedAt: now,
  })) as WorkflowNodeGroupDefinition
  if (!definition.metadata.name) throw new Error("Node group name is required")
  await ports.repository.putRelease(definition)
  ports.catalog.upsert(`user:${input.scope}`, definition)
  return definition
}
