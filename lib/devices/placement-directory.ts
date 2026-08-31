/**
 * The shared candidate directory — one answer to "which machines could run
 * this?", replacing three that could not see each other.
 *
 * Before this, every consumer built its own option list from a different
 * source and with a different idea of "eligible":
 *
 *   * the workflow editor listed only remote Hosts whose manifest carried
 *     `workflow.execution`, and **silently omitted everything else** — an
 *     offline Host and a phone were equally invisible, so "why did this not
 *     run there?" had no answer anywhere in the UI;
 *   * the teammate binding field read `useFleetSnapshot()` workers;
 *   * `action.mobile.*` sorted paired devices by `lastSeenAt`.
 *
 * A directory plus `evaluatePlacement` replaces all three: consumers state
 * their requirements, every candidate is returned with a verdict, and an
 * ineligible one renders disabled with a typed {@link PlacementReason} instead
 * of vanishing.
 *
 * Capacity is deliberately unbounded here. This module answers "may this
 * machine be chosen", and it has no load telemetry for a Host or a phone —
 * claiming `maxUnits` we cannot observe would reject work over a number we
 * invented. `remote-worker-runtime.ts` keeps its own candidate projection with
 * real `activeTurns` / `maxActiveTurns` for the dispatch decision.
 */

import { evaluatePlacement } from "@/lib/placement/evaluate"
import type {
  PlacementCandidate,
  PlacementCandidateKind,
  PlacementRequirement,
  PlacementVerdict,
} from "@/lib/placement/types"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"

import type { DeviceKind, DevicePlacementSummary, DeviceRow, DeviceShellTierRow } from "./types"

/**
 * The placement kind a row maps onto, or `null` when it maps onto none.
 *
 * This was an identity function while the two unions were the same space. They
 * are not any more: an SSH host is a machine the console lists but that
 * `evaluatePlacement` must never pick, because `ssh_terminal_*` gives a shell
 * and nothing else. Returning `null` rather than inventing a candidate kind is
 * what keeps the resolver from promising an execution the transport cannot
 * perform.
 */
export function placementKindFor(kind: DeviceKind): PlacementCandidateKind | null {
  return kind === "ssh-host" ? null : kind
}

export interface DevicePlacementInput {
  kind: DeviceKind
  /** `CapabilityId` strings the device reported. */
  platformCapabilities?: readonly string[]
  /** SecurityStore / agent capability ids, for workers. */
  agentCapabilities?: readonly string[]
  /** A Host's advertised operation contracts. */
  featureManifest?: HostFeatureManifest
  /** Available sandbox tiers — only ever known for the local machine. */
  shellTiers?: readonly DeviceShellTierRow[]
}

/**
 * What one device offers, per dimension.
 *
 * This is where the sandbox tier finally reaches placement.
 * `PlacementDimension` has carried `"sandbox"` since ADR-0136 and nothing ever
 * produced a value for it, so `sandbox_mismatch` was a reason no candidate
 * could trigger. A tier only counts when it is actually executable: an
 * unregistered microVM adapter makes `executeSandbox` throw
 * `microvm-unavailable` with host fallback forbidden, so advertising the tier
 * would promise an execution that is guaranteed to refuse.
 */
export function buildDevicePlacement(input: DevicePlacementInput): DevicePlacementSummary {
  const provides: PlacementRequirement[] = []

  for (const value of input.platformCapabilities ?? []) {
    provides.push({ dimension: "platform", value })
  }
  for (const value of input.agentCapabilities ?? []) {
    provides.push({ dimension: "agent", value })
  }
  if (input.featureManifest) {
    for (const [feature, descriptor] of Object.entries(input.featureManifest.features)) {
      if (descriptor) provides.push({ dimension: "host-feature", value: feature })
    }
  }
  for (const tier of input.shellTiers ?? []) {
    if (tier.available) provides.push({ dimension: "sandbox", value: tier.tier })
  }

  return { provides, activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY }
}

/**
 * Project console rows onto the shared placement vocabulary.
 *
 * Rows with no placement kind are dropped, so this can return fewer entries
 * than it was given. Callers that need a per-row answer must not index by
 * position; {@link buildDeviceOptions} pairs them back up by row instead.
 */
export function deviceCandidates(rows: readonly DeviceRow[]): PlacementCandidate[] {
  return rows.flatMap((row) => {
    const kind = placementKindFor(row.kind)
    if (!kind) return []
    return [
      {
        ref: row.ref,
        kind,
        liveness: row.liveness,
        provides: row.placement.provides,
        activeUnits: row.placement.activeUnits,
        maxUnits: row.placement.maxUnits,
        labels: {
          label: row.label,
          kind: row.kind,
          reachability: row.reachability,
        },
      },
    ]
  })
}

export interface DeviceOption {
  row: DeviceRow
  /**
   * `null` for a row that is not in the candidate space at all, such as an SSH
   * host. Distinct from a candidate that merely failed the requirements.
   */
  candidate: PlacementCandidate | null
  verdict: PlacementVerdict
  /** Convenience mirror of `verdict.ready` for `disabled=` in a Select. */
  eligible: boolean
}

/**
 * Every device, each with a verdict against `requirements`.
 *
 * Returns ineligible candidates rather than filtering them out — that is the
 * whole point. A picker renders them disabled with their reason, so the user
 * can see that a Host is merely asleep rather than concluding it was never
 * paired.
 *
 * A row with no placement kind gets the same treatment for the same reason: it
 * is listed, disabled, as `not_permitted`. "Why is my SSH box not in this
 * list?" is exactly the question this module exists to stop people asking.
 */
export function buildDeviceOptions(
  rows: readonly DeviceRow[],
  requirements: readonly PlacementRequirement[],
  now: number
): DeviceOption[] {
  return rows.map((row) => {
    const candidate = deviceCandidates([row])[0] ?? null
    const verdict: PlacementVerdict = candidate
      ? evaluatePlacement(candidate, requirements, now)
      : { ready: false, reason: "not_permitted" }
    return { row, candidate, verdict, eligible: verdict.ready }
  })
}

/**
 * Requirement helpers, so consumers never hand-write a dimension string.
 *
 * Only {@link requireHostFeature} has a production caller today (the workflow
 * run-on picker). The other two are deliberate: a helper set that covers one
 * dimension out of the three a caller might plausibly ask for invites the next
 * consumer to hand-write `{ dimension: "sandbox", value }` and get the string
 * wrong. They are exercised by this module's test, not dead-but-unreferenced.
 */
export const requirePlatform = (value: string): PlacementRequirement => ({
  dimension: "platform",
  value,
})
export const requireHostFeature = (value: string): PlacementRequirement => ({
  dimension: "host-feature",
  value,
})
export const requireSandboxTier = (value: string): PlacementRequirement => ({
  dimension: "sandbox",
  value,
})
