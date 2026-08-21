import { isPlaceable, type LivenessPolicy } from "./liveness"
import type { PlacementCandidate, PlacementRequirement, PlacementVerdict } from "./types"

/**
 * Can this candidate run this work, right now?
 *
 * Generalized from `evaluateRemoteWorkerPlacement`, which was already the only
 * complete implementation of this question in the codebase — eleven typed
 * rejection reasons, checked in a fixed order so the reported reason is stable
 * rather than "whichever check happened to be first today".
 *
 * Order matters and is deliberate: liveness before capability before capacity.
 * A candidate that is offline *and* incompatible reports `offline`, because
 * that is the condition a human can act on.
 */
export function evaluatePlacement(
  candidate: PlacementCandidate,
  requirements: readonly PlacementRequirement[],
  now: number,
  policy: LivenessPolicy = {}
): PlacementVerdict {
  if (!isPlaceable(candidate.liveness, now, policy)) {
    return { ready: false, reason: "offline" }
  }

  const provided = new Set(
    candidate.provides.map((requirement) => `${requirement.dimension}:${requirement.value}`)
  )
  const missing = requirements.filter(
    (requirement) => !provided.has(`${requirement.dimension}:${requirement.value}`)
  )
  if (missing.length > 0) {
    return { ready: false, reason: reasonFor(missing), missing }
  }

  if (candidate.activeUnits >= candidate.maxUnits) {
    return { ready: false, reason: "capacity_exhausted" }
  }
  return { ready: true }
}

/**
 * Name the rejection after the dimension that failed.
 *
 * "Missing a workspace binding" and "missing a sandbox feature" need different
 * fixes from whoever reads the reason, so collapsing both into a generic
 * mismatch would make the diagnostic useless at exactly the moment it matters.
 */
function reasonFor(missing: readonly PlacementRequirement[]) {
  const dimensions = new Set(missing.map((requirement) => requirement.dimension))
  if (dimensions.has("workspace")) return "workspace_missing" as const
  if (dimensions.has("credential")) return "credential_missing" as const
  if (dimensions.has("sandbox")) return "sandbox_mismatch" as const
  return "capability_mismatch" as const
}
