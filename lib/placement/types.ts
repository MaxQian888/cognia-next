/**
 * Where a unit of work runs.
 *
 * ADR-0097's own "Not done" section says it plainly: *nothing chooses where a
 * run executes*. Each subsystem answered the question for itself — AgentTeam
 * picked a worker, `action.mobile.*` picked a phone, the workflow preflight
 * approximated with a union, the scheduler assumed "here" — and none of them
 * could see the others' answers or reasons.
 *
 * This is that missing vocabulary. It is deliberately a generalization of
 * `lib/ai/agent/team/remote-worker-runtime.ts`, which was already a complete
 * placement resolver for one candidate kind: the same reason values, the same
 * deterministic tiebreak, the same "waiting is not failure" distinction.
 */

import type { PlacementLiveness } from "./liveness"

/** What kind of thing can run work. */
export type PlacementCandidateKind =
  /** An enrolled execution worker reached over Agent RPC. */
  | "worker"
  /** A paired phone/tablet reached over the companion transport. */
  | "paired-device"
  /** A remote Host this client is driving (ADR-0082). */
  | "remote-host"
  /** This process. */
  | "local"

/**
 * Which vocabulary a requirement is expressed in.
 *
 * `CapabilityId` (platform surfaces: camera, always-on, headless) and
 * `AgentCapabilityId` (execution features: streaming, tools) are different
 * value spaces owned by different modules. Merging them would invent a third
 * vocabulary nobody owns, so the requirement carries a discriminant instead
 * and each source matches only the dimension it understands.
 */
export type PlacementDimension =
  | "platform"
  | "agent"
  | "sandbox"
  | "workspace"
  | "credential"
  /**
   * A versioned operation contract a Host advertises (`HostFeatureId`).
   *
   * Its own value space for the same reason `platform` and `agent` are: the
   * ids are minted by `lib/platform/host-feature-manifest.ts` and carry a
   * version and an operation list, so a Host `workflow.execution` is not a
   * platform capability and must not satisfy one. Callers that previously
   * filtered hosts by reading `featureManifest.features[...]` directly can
   * express the same requirement here and get a typed `PlacementReason` back
   * instead of silently dropping the candidate from a list.
   */
  | "host-feature"

export interface PlacementRequirement {
  dimension: PlacementDimension
  /** A value from the dimension's own vocabulary. Never cross-checked. */
  value: string
}

export interface PlacementCandidate {
  /** Stable identity within its kind — `hostRef`, `deviceId`, host id, or "local". */
  ref: string
  kind: PlacementCandidateKind
  liveness: PlacementLiveness
  /** Requirements this candidate can satisfy, by dimension. */
  provides: readonly PlacementRequirement[]
  /** Concurrent units already running here. */
  activeUnits: number
  /** Concurrent units this candidate accepts; `Infinity` for uncapped. */
  maxUnits: number
  /** Free-form detail for diagnostics and UI. Never used for matching. */
  labels?: Readonly<Record<string, string>>
}

/**
 * Why a candidate was rejected.
 *
 * These values are persisted (`AgentTeamChildRun.placementReason`), so the
 * union is append-only and existing members may never be renamed.
 */
export type PlacementReason =
  | "offline"
  | "deployment_mismatch"
  | "capability_mismatch"
  | "sandbox_mismatch"
  | "workspace_missing"
  | "credential_missing"
  | "capacity_exhausted"
  | "not_permitted"

export type PlacementVerdict =
  | { ready: true }
  | { ready: false; reason: PlacementReason; missing?: readonly PlacementRequirement[] }

/** How a caller wants placement resolved. */
export type PlacementConstraint =
  /** Run wherever the parent ran. The zero-configuration default. */
  | { mode: "colocate" }
  /** Run on exactly this candidate, or wait for it. */
  | { mode: "pinned"; ref: string }
  /** Run on the least-loaded compatible candidate. */
  | { mode: "auto" }

/**
 * No candidate is ready *yet*.
 *
 * Distinct from a failure on purpose: a pinned host that is asleep and a
 * fleet that is momentarily saturated are both "come back in a moment", and
 * collapsing them into an error is what turns a transient condition into a
 * failed run.
 */
export class PlacementWaitingError extends Error {
  constructor(
    readonly waiting: "pinned_candidate_unavailable" | "no_compatible_capacity",
    readonly ref?: string,
    readonly reason?: PlacementReason
  ) {
    super(
      waiting === "pinned_candidate_unavailable"
        ? `Pinned placement target is unavailable: ${ref ?? "unknown"}`
        : "No compatible placement target has available capacity"
    )
    this.name = "PlacementWaitingError"
  }
}
