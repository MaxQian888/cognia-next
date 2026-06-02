"use client"

/**
 * Per-node decoration hook for the workflow editor canvas. (A4)
 *
 * The decoration is the live-state fringe a node renders around its
 * static `data`: run status (running / succeeded / failed / …), validation
 * error summary, and the most-recent run's outcome footer.
 *
 * Before A4, the canvas merged these into each node's `data` via a
 * `decoratedNodes = nodes.map(...)` recomputed on every `runStatus` /
 * `validation` / `lastRun` mutation — meaning every status flip on any
 * node triggered an O(n) rebuild plus a re-render of every node component
 * via React Flow's identity-based reconciliation.
 *
 * After A4, each `WorkflowNodeComponent` subscribes to ONLY its own slot
 * in `runStatusByStepId[id]`, `validationByStepId[id]`, and
 * `lastRunByStepId[id]`. Zustand's `useShallow` returns the same object
 * identity when none of the three keys change, so unrelated mutations do
 * not re-render this node.
 *
 * In tests where no `<EditorStoreProvider>` is mounted, the hook returns
 * an empty decoration so the node still renders cleanly.
 */

import { useShallow } from "zustand/react/shallow"
import type { NodeValidationResult } from "@/lib/workflow/nodes/validate-params"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"
import { useEditorStoreOrNull } from "./store-context"
import type { EditorState, NodeRunStatus } from "./store"

export interface NodeDecoration {
  runStatus: NodeRunStatus | undefined
  validation: NodeValidationResult | undefined
  lastRun: LastRunSummary | undefined
  /** True when this node has pinned test data (editor runs use it). */
  pinned: boolean
}

const EMPTY_DECORATION: NodeDecoration = Object.freeze({
  runStatus: undefined,
  validation: undefined,
  lastRun: undefined,
  pinned: false,
})

export function useNodeDecoration(nodeId: string): NodeDecoration {
  const store = useEditorStoreOrNull()
  // Build the selector unconditionally so `useShallow` retains a stable
  // identity across renders — calling `useShallow` inside a conditional
  // would violate the hook rules.
  const selector = useShallow(
    (s: EditorState): NodeDecoration => ({
      runStatus: s.runStatusByStepId[nodeId],
      validation: s.validationByStepId[nodeId],
      lastRun: s.lastRunByStepId[nodeId],
      pinned: s.baseWorkflow.pinData?.[nodeId] !== undefined,
    })
  )
  // `store` is itself a hook (Zustand `useBoundStore`), so we either call
  // it or fall through to the empty decoration. The optional-call pattern
  // matches the rest of the editor's "render-without-store" affordance
  // (see `workflow-node.tsx`).
  const decoration = store ? store(selector) : null
  return decoration ?? EMPTY_DECORATION
}
