/**
 * Pure markdown builder for a HISTORICAL run replay (`/workflow runs` → pick a
 * row). Unlike the live panel — which streams while a run is in flight — this
 * renders a finished run from its frozen snapshot + persisted event log into one
 * scrollable pager document: the step timeline, the graph topology, and a
 * per-step inspector section for every step that executed.
 *
 * Pure composition over the existing renderers (`buildRunTimeline`,
 * `buildDagAscii`, `buildStepInspectorDoc`) — no Dexie, no Ink, no duplication.
 */
import type { RunStatus, WorkflowRunEventRow } from "@/types/workflow/visual"

import { buildDagAscii, type DagEdgeLike, type DagNodeLike } from "./workflow-dag"
import { buildRunTimeline } from "./workflow-run-timeline"
import { buildStepInspectorDoc } from "./workflow-step-doc"
import type { RunStepView, RunUsageTotals } from "./workflow-run-fold"

export interface RunReplayInput {
  workflowName: string
  status: RunStatus
  /** Folded step views (from `foldRunEvents`). */
  steps: RunStepView[]
  /** The run's raw persisted events (for the per-step inspector sections). */
  events: WorkflowRunEventRow[]
  /** Graph nodes from the run's frozen snapshot (for the topology view). */
  nodes: ReadonlyArray<DagNodeLike>
  /** Graph edges from the run's frozen snapshot. */
  edges: ReadonlyArray<DagEdgeLike>
  /** Run-level usage totals, when any step reported usage. */
  usage?: RunUsageTotals
}

const SEP = "\n\n---\n\n"

/** Build the full replay document for a finished run. */
export function buildRunReplayDoc(input: RunReplayInput): string {
  const sections: string[] = [
    buildRunTimeline({ name: input.workflowName }, input.steps, input.status, input.usage),
    buildDagAscii(input.nodes, input.edges, { title: "Structure" }),
  ]

  // Per-step detail only for steps that actually ran (skip never-reached ones).
  const ran = input.steps.filter((s) => s.status !== "pending")
  if (ran.length > 0) {
    const details = ran.map((s) => buildStepInspectorDoc(s, input.events)).join(SEP)
    sections.push(`## Step details${SEP}${details}`)
  }

  return sections.join(SEP)
}
