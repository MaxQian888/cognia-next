import type { EditorState } from "./store"

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

/** Stable semantic graph token used as the Workflow proposal CAS revision. */
export function workflowEditorRevision(state: Pick<EditorState, "nodes" | "edges">): string {
  const graph = {
    nodes: [...state.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) =>
        stableValue({
          id: node.id,
          type: node.type,
          position: node.position,
          parentId: node.parentId,
          extent: node.extent,
          data: node.data,
        })
      ),
    edges: [...state.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) =>
        stableValue({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          type: edge.type,
          label: edge.label,
          data: edge.data,
        })
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
