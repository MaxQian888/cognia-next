/**
 * Expression-reference validation. Walks every node's `params` for
 * `{{ $node['id']… }}` references and flags:
 *   • `exprUnknownNode` (error) — the referenced id is not a node in the graph;
 *   • `exprNotUpstream` (warning) — the node exists but isn't upstream of the
 *     referencing node, so its output won't be available at run time.
 *
 * Reuses the safe expression parser (`runtime/expression.ts`) to locate refs
 * and the shared `upstream-graph` reachability to decide scope — never `eval`.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { parseExpression, tokenize } from "@/lib/workflow/runtime/expression"
import { computeUpstreamNodeIds, type GraphNodeLike } from "@/lib/workflow/editor/upstream-graph"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

/** Top-level form field for a dotted/bracketed param path (`a.b[0]` → `a`). */
function topField(path: string): string {
  return path.split(".")[0].split("[")[0]
}

/** Recursively visit every string leaf in a params object with its path. */
function walkStrings(value: unknown, visit: (str: string, path: string) => void, path = ""): void {
  if (typeof value === "string") {
    visit(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, visit, `${path}[${i}]`))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkStrings(child, visit, path ? `${path}.${key}` : key)
    }
  }
}

export function checkExpressionRefs(wf: VisualWorkflow): Diagnostic[] {
  const out: Diagnostic[] = []
  const nodeIdSet = new Set(wf.nodes.map((n) => n.id))
  const graphNodes: GraphNodeLike[] = wf.nodes.map((n) => ({ id: n.id, kind: n.type }))

  for (const node of wf.nodes) {
    const params = node.data?.params
    if (!params || typeof params !== "object") continue
    // Compute upstream once per node (small graphs; cheap reverse-BFS).
    let upstream: Set<string> | null = null
    const ensureUpstream = (): Set<string> => {
      if (!upstream) upstream = computeUpstreamNodeIds(node.id, graphNodes, wf.edges)
      return upstream
    }

    walkStrings(params, (str, path) => {
      if (!str.includes("$node")) return
      for (const segment of parseExpression(str)) {
        if (segment.kind !== "expr") continue
        const tokens = tokenize(segment.value)
        const head = tokens[0]
        if (!head || head.kind !== "node") continue
        const ref = head.id
        const field = topField(path)
        if (ref === node.id || !nodeIdSet.has(ref)) {
          if (!nodeIdSet.has(ref)) {
            out.push(
              makeDiagnostic({
                severity: "error",
                code: "exprUnknownNode",
                nodeId: node.id,
                field,
                messageParams: { ref },
              })
            )
          } else {
            // self-reference: exists but never upstream of itself
            out.push(
              makeDiagnostic({
                severity: "warning",
                code: "exprNotUpstream",
                nodeId: node.id,
                field,
                messageParams: { ref },
              })
            )
          }
          continue
        }
        if (!ensureUpstream().has(ref)) {
          out.push(
            makeDiagnostic({
              severity: "warning",
              code: "exprNotUpstream",
              nodeId: node.id,
              field,
              messageParams: { ref },
            })
          )
        }
      }
    })
  }
  return out
}
