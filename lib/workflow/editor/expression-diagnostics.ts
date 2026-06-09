/**
 * Inline expression-reference diagnostics for the CodeMirror editor. Scans the
 * field text for `{{ … $node['id'] … }}` references and reports each one whose
 * target node is unknown or not upstream of the current node, with character
 * ranges so the editor can underline the exact `$node[...]` token.
 *
 * Pure — no CodeMirror import — so it's unit-testable. The component maps the
 * `code` to a localized message (reusing `workflows.diagnostics.*`).
 */

import { computeUpstreamNodeIds, type GraphEdgeLike, type GraphNodeLike } from "./upstream-graph"

export interface ExpressionRefDiagnostic {
  /** Start offset of the `$node[...]` token in the full field text. */
  from: number
  /** End offset (exclusive). */
  to: number
  severity: "error" | "warning"
  code: "unknownNode" | "notUpstream"
  /** The referenced node id. */
  ref: string
}

// `{{ … }}` blocks (non-greedy, multi-line).
const MUSTACHE = /\{\{([\s\S]*?)\}\}/g
// `$node['id']` / `$node["id"]` with optional inner whitespace.
const NODE_REF = /\$node\s*\[\s*['"]([^'"]+)['"]\s*\]/g

export function computeExpressionDiagnostics(
  text: string,
  currentNodeId: string,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): ExpressionRefDiagnostic[] {
  if (!text.includes("$node")) return []
  const nodeIds = new Set(nodes.map((n) => n.id))
  let upstream: Set<string> | null = null
  const ensureUpstream = (): Set<string> => {
    if (!upstream) upstream = computeUpstreamNodeIds(currentNodeId, nodes, edges)
    return upstream
  }

  const out: ExpressionRefDiagnostic[] = []
  MUSTACHE.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = MUSTACHE.exec(text)) !== null) {
    const innerStart = block.index + 2 // past the opening "{{"
    const inner = block[1]
    NODE_REF.lastIndex = 0
    let ref: RegExpExecArray | null
    while ((ref = NODE_REF.exec(inner)) !== null) {
      const id = ref[1]
      const from = innerStart + ref.index
      const to = from + ref[0].length
      if (!nodeIds.has(id)) {
        out.push({ from, to, severity: "error", code: "unknownNode", ref: id })
      } else if (id === currentNodeId || !ensureUpstream().has(id)) {
        out.push({ from, to, severity: "warning", code: "notUpstream", ref: id })
      }
    }
  }
  return out
}
