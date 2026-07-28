/**
 * Forward migration for the visual workflow JSON shape. Pure and idempotent:
 * a workflow already at the current `schemaVersion` is returned by reference.
 *
 * v1 → v2 is **additive**. The only structural feature of v2 (the loop
 * container) is opt-in via a node's `typeVersion`, so a v1 graph needs no node
 * rewrites — legacy flat `flow.loop` nodes stay at typeVersion 1 and keep their
 * transform-mode semantics. We only bump the top-level stamp so writers and
 * the editor know the row has been seen by the v2 code path.
 *
 * Applied on the DB read funnel (`lib/db/workflows.ts`) and on editor load.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { resolveWorkflowKindAlias } from "./kind-aliases"

const CURRENT_SCHEMA_VERSION = 2 as const

export function migrateWorkflow(wf: VisualWorkflow): VisualWorkflow {
  const nodes = wf.nodes.map((node) => {
    const type = resolveWorkflowKindAlias(node.type)
    return type === node.type ? node : { ...node, type }
  })
  const aliasesChanged = nodes.some((node, index) => node !== wf.nodes[index])
  if (wf.schemaVersion >= CURRENT_SCHEMA_VERSION && !aliasesChanged) return wf
  // v1 → v2: stamp only. No node/edge rewrites (additive change).
  return { ...wf, nodes, schemaVersion: CURRENT_SCHEMA_VERSION }
}
