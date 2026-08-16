/**
 * Permission diff shown at step 4, before any file is written (ADR-0117).
 *
 * The rule the diff encodes: *widening needs approval, narrowing never does*.
 * A regenerated artifact that drops a capability is strictly safer than the one
 * it replaces, and prompting for it trains users to click through the prompt
 * that actually matters.
 *
 * Capability ids are compared as opaque strings. Creator does not know what a
 * given subsystem's capabilities mean, and inventing a hierarchy here ("fs.read
 * is implied by fs.write") would silently approve capabilities the target
 * subsystem does not actually treat as implied.
 */

import type { CreatorCapabilityChange, CreatorPermissionDiff } from "@/types/creator"

export interface PermissionDiffInput {
  /** Capabilities the currently-installed / previously-generated artifact has. */
  current: readonly string[]
  /** Capabilities the proposed artifact declares. */
  proposed: readonly string[]
  /** Optional per-capability justification from the generator. */
  rationales?: Readonly<Record<string, string>>
}

/**
 * Compute the diff.
 *
 * Output ordering is stable (added, then removed, then unchanged; alphabetical
 * within each group) so the same proposal always renders the same list and a
 * screenshot diff in review is meaningful.
 */
export function computePermissionDiff(input: PermissionDiffInput): CreatorPermissionDiff {
  const current = new Set(input.current.map(normalizeCapability).filter(Boolean))
  const proposed = new Set(input.proposed.map(normalizeCapability).filter(Boolean))

  const added = [...proposed].filter((cap) => !current.has(cap)).sort()
  const removed = [...current].filter((cap) => !proposed.has(cap)).sort()
  const unchanged = [...proposed].filter((cap) => current.has(cap)).sort()

  const changes: CreatorCapabilityChange[] = [
    ...added.map((capability) => entry(capability, "added", input.rationales)),
    ...removed.map((capability) => entry(capability, "removed", input.rationales)),
    ...unchanged.map((capability) => entry(capability, "unchanged", input.rationales)),
  ]

  return {
    changes,
    added,
    removed,
    // Only widening gates. An empty proposal against a non-empty current set is
    // pure removal and passes without a prompt.
    requiresApproval: added.length > 0,
  }
}

function entry(
  capability: string,
  change: CreatorCapabilityChange["change"],
  rationales: PermissionDiffInput["rationales"]
): CreatorCapabilityChange {
  const rationale = rationales?.[capability]
  return rationale ? { capability, change, rationale } : { capability, change }
}

/** Trim and collapse whitespace; empty ids are dropped rather than compared. */
function normalizeCapability(capability: string): string {
  return capability.trim()
}

/**
 * Whether a granted approval still covers this diff.
 *
 * Approval is bound to the exact set of added capabilities it was granted for.
 * If the generator re-runs and asks for one more capability, the previous
 * approval no longer applies — otherwise a second generation pass could smuggle
 * a capability in behind an approval the user gave for a smaller set.
 */
export function approvalCoversDiff(
  approvedAdditions: readonly string[],
  diff: CreatorPermissionDiff
): boolean {
  if (!diff.requiresApproval) return true
  const approved = new Set(approvedAdditions.map(normalizeCapability))
  return diff.added.every((capability) => approved.has(capability))
}
