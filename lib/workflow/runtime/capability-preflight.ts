/**
 * Run-time capability preflight (ADR 0060 — L0).
 *
 * Before any step executes, the orchestrator checks every executable node's
 * capability requirements (`NodeCatalogEntry.requires`, with legacy
 * `desktopOnly` mapped via `effectiveRequires`) against what the local
 * runtime can do. A miss fails the run at t=0 with one structured,
 * recoverable failure (`capability-missing:<cap>`) instead of an
 * executor-internal throw halfway through a run with side effects.
 *
 * Deliberately NOT part of `validateWorkflow`: validation is
 * platform-agnostic and shared with the editor — a saved desktop workflow
 * must stay "valid" when opened on web. Capability is a property of *this
 * runner*, not of the definition. The preflight re-runs on resume by design:
 * a device resuming a run must also hold the required capabilities.
 */

import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { detectLocalCapabilities, type CapabilityId } from "@/lib/platform/capabilities"
import { missingCapabilities, nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

export interface CapabilityPreflightFailure {
  nodeId: string
  kind: WorkflowNodeKind
  missing: CapabilityId[]
}

/** Error-code prefix stamped on the run row; suffix = first missing capability. */
export const CAPABILITY_MISSING_CODE_PREFIX = "capability-missing:"

export interface CapabilityPreflightOptions {
  /**
   * When set, only these node ids are checked — mirrors the orchestrator's
   * `restrictToStepIds` bounding (single-node runs must not fail on
   * unrelated nodes elsewhere in the graph).
   */
  restrictToNodeIds?: ReadonlyArray<string>
  /**
   * Node ids whose outputs are pre-seeded (`seedOutputs`) — they cache-hit
   * instead of executing, so their requirements don't apply.
   */
  seededNodeIds?: ReadonlyArray<string>
}

/**
 * Check every executable node (loop-container children included — they run
 * via the loop runtime; `annotation.*` excluded — no execution) against
 * `local`. Returns one failure per node with unmet requirements, in node
 * order. Empty array = clear to run.
 */
export function preflightCapabilities(
  workflow: Pick<VisualWorkflow, "nodes">,
  local: readonly CapabilityId[] = detectLocalCapabilities(),
  opts: CapabilityPreflightOptions = {}
): CapabilityPreflightFailure[] {
  const restrict = opts.restrictToNodeIds ? new Set(opts.restrictToNodeIds) : undefined
  const seeded = new Set(opts.seededNodeIds ?? [])
  const failures: CapabilityPreflightFailure[] = []
  for (const node of workflow.nodes) {
    if (node.type.startsWith("annotation.")) continue
    if (restrict && !restrict.has(node.id)) continue
    if (seeded.has(node.id)) continue
    const missing = missingCapabilities(nodeCatalogEntry(node.type), local)
    if (missing.length > 0) failures.push({ nodeId: node.id, kind: node.type, missing })
  }
  return failures
}

/** One-line human summary used as the run failure message. */
export function formatPreflightFailures(failures: CapabilityPreflightFailure[]): string {
  const parts = failures.map((f) => `${f.nodeId} (${f.kind}): ${f.missing.join(", ")}`)
  return `Missing platform capabilities — ${parts.join("; ")}`
}
