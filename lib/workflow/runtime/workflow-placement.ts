import { evaluatePlacement } from "@/lib/placement/evaluate"
import { selectPlacement, type PlacementSelection } from "@/lib/placement/select"
import type {
  PlacementCandidate,
  PlacementConstraint,
  PlacementVerdict,
} from "@/lib/placement/types"

export interface WorkflowHostCandidate extends PlacementCandidate {
  /** Digest of the active deployment resolved by this Host. */
  deploymentDigest: string | null
}

export interface SelectWorkflowHostInput {
  constraint: PlacementConstraint
  candidates: readonly WorkflowHostCandidate[]
  expectedDeploymentDigest: string
  now: number
}

/**
 * Select a Host for one published top-level workflow invocation.
 *
 * The shared placement resolver still owns liveness, capacity, load ordering,
 * and deterministic ties. This adapter adds the workflow-specific invariant:
 * a Host is compatible only when its active immutable deployment has the exact
 * digest selected by the source Host.
 */
export function selectWorkflowHost(input: SelectWorkflowHostInput): PlacementSelection {
  return selectPlacement(input.candidates, input.constraint, [], input.now, {
    evaluate(candidate): PlacementVerdict {
      const workflowCandidate = candidate as WorkflowHostCandidate
      const baseVerdict = evaluatePlacement(candidate, [], input.now)
      if (!baseVerdict.ready) return baseVerdict
      if (workflowCandidate.deploymentDigest !== input.expectedDeploymentDigest) {
        return { ready: false, reason: "deployment_mismatch" }
      }
      return baseVerdict
    },
  })
}
