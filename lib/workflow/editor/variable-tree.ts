/**
 * Build the upstream-variable tree for the Variable Picker (Dify's
 * VarReferencePicker analogue): every node transitively upstream of the
 * current one, each expanded into its resolved output fields. Pure — the
 * popover component renders it and inserts `field.insert` at the cursor.
 */

import { buildNodeRef } from "./expr-ref"
import { flattenSchema } from "./node-io-data"
import { upstreamNodesFor, type GraphEdgeLike } from "./upstream-graph"

export interface VarTreeField {
  /** Display path relative to the node output (e.g. "result.text"). */
  path: string
  /** Full insert string: `{{ $node['id'].result.text }}`. */
  insert: string
  /** Inferred type ("string" / "number" / "array" / "object" / …). */
  type: string
  /** Short value sample for the row hint. */
  sample: string
}

export interface VarTreeNode {
  nodeId: string
  label: string
  kind: string
  /** Hops from the current node (1 = direct predecessor). */
  distance: number
  /** `{{ $node['id'] }}` — insert the whole output object. */
  baseInsert: string
  fields: VarTreeField[]
}

export interface VarTreeNodeInput {
  id: string
  kind: string
  label: string
}

/**
 * Build the tree of insertable references available to `currentNodeId`.
 * `outputs` maps node id → that node's resolved output (pin-overlaid run data);
 * nodes with no resolved output still appear (base ref only).
 */
export function buildVariableTree(
  currentNodeId: string,
  nodes: ReadonlyArray<VarTreeNodeInput>,
  edges: ReadonlyArray<GraphEdgeLike>,
  outputs: Record<string, unknown>
): VarTreeNode[] {
  const labelById = new Map(nodes.map((n) => [n.id, n.label]))
  const upstream = upstreamNodesFor(
    currentNodeId,
    nodes.map((n) => ({ id: n.id, kind: n.kind })),
    edges
  )
  return upstream.map((u) => {
    const output = outputs[u.id]
    const fields: VarTreeField[] =
      output !== undefined && output !== null
        ? flattenSchema(output, { maxDepth: 4, maxRows: 100 }).map((row) => ({
            path: row.path,
            insert: buildNodeRef(u.id, row.segments),
            type: row.type,
            sample: row.sample,
          }))
        : []
    return {
      nodeId: u.id,
      label: labelById.get(u.id) ?? u.id,
      kind: u.kind,
      distance: u.distance,
      baseInsert: buildNodeRef(u.id, []),
      fields,
    }
  })
}

export interface VarTreeFilter {
  /** Case-insensitive substring matched against node label and field path. */
  query?: string
  /** Keep only fields of this type (and nodes that still have a match). */
  type?: string
}

/**
 * Filter the tree. A node is kept when its label/id matches the query, or when
 * it has at least one field matching both query and type. Type-filtering an
 * empty-field node drops it (no field can match the type).
 */
export function filterVarTree(tree: VarTreeNode[], filter: VarTreeFilter): VarTreeNode[] {
  const q = filter.query?.trim().toLowerCase()
  const wantType = filter.type
  if (!q && !wantType) return tree

  const out: VarTreeNode[] = []
  for (const node of tree) {
    const nodeMatches = q
      ? node.label.toLowerCase().includes(q) || node.nodeId.toLowerCase().includes(q)
      : false
    const fields = node.fields.filter((f) => {
      if (wantType && f.type !== wantType) return false
      if (q && !f.path.toLowerCase().includes(q)) return false
      return true
    })
    // Keep the node if it has surviving fields, OR (no type filter) the node
    // name itself matched the query.
    if (fields.length > 0 || (nodeMatches && !wantType)) {
      out.push({ ...node, fields })
    }
  }
  return out
}
