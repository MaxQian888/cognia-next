/**
 * Structural reachability check. Cycle / dangling / container checks live in
 * `lib/workflow/definition/validate.ts` (shared with the runtime); this adds
 * the editor-only "orphan / unreachable" warning that the runtime doesn't need
 * to block on.
 *
 * A node is an orphan when it can't be reached from any trigger by following
 * forward edges. Skipped: triggers themselves, annotations, and container
 * members (which are reached through their loop container, not via top-level
 * edges). When the workflow has no trigger at all we stay silent — the
 * `missingTrigger` integrity warning already covers that, and flagging every
 * node as unreachable would just be noise.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

export function checkReachability(wf: VisualWorkflow): Diagnostic[] {
  const triggers = wf.nodes.filter((n) => n.type.startsWith("trigger."))
  if (triggers.length === 0) return []

  const adj = new Map<string, string[]>()
  for (const edge of wf.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    adj.get(edge.source)!.push(edge.target)
  }

  const reachable = new Set<string>()
  const stack: string[] = []
  for (const t of triggers) {
    if (!reachable.has(t.id)) {
      reachable.add(t.id)
      stack.push(t.id)
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        stack.push(next)
      }
    }
  }

  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    if (node.type.startsWith("trigger.")) continue
    if (node.type.startsWith("annotation.")) continue
    if (node.parentId) continue // reached via its loop container
    if (!reachable.has(node.id)) {
      out.push(makeDiagnostic({ severity: "warning", code: "orphanNode", nodeId: node.id }))
    }
  }
  return out
}
