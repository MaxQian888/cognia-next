/**
 * The independent Creator reviewer (ADR-0117, step 8).
 *
 * "Independent" is two separate properties, and both matter:
 *
 * 1. **Read-only.** The reviewer resolves to `plan` authority and a read-only
 *    view of the authoring root. A reviewer that can edit the thing it is
 *    reviewing can make its own findings disappear, which turns the review step
 *    into a rubber stamp.
 * 2. **Independent context.** It does not inherit the authoring conversation.
 *    A reviewer that has read the generator's reasoning tends to agree with it;
 *    it gets the artifact, the diff and the requirements, and nothing else.
 *
 * Authority is derived through `resolveChildComposition`, so the reviewer is
 * bounded by the parent's *resolved* authority and can only ever narrow it.
 */

import { resolveChildComposition } from "@/lib/agent/composition/resolve-composition"
import type { UndigestedComposition } from "@/lib/agent/composition/resolve-composition"
import { authoringRootPolicy } from "./authoring-root"
import type { FileAccessPolicy } from "@/types/files"
import type {
  AgentPresetDefinitionV1,
  ResolvedAgentCompositionV1,
} from "@cognia/agent-config-types/agent-composition"
import type {
  AuthoringRoot,
  CreatorArtifactKind,
  CreatorPermissionDiff,
  CreatorReviewFinding,
  CreatorReviewVerdict,
} from "@/types/creator"

/** Preset id the reviewer runs under — Minimal, i.e. read-only core tools. */
export const REVIEWER_PRESET_ID = "minimal"

export interface ReviewerCompositionInput {
  /**
   * The Creator turn's resolved composition; the reviewer's ceiling on both
   * authority and autonomy. The reviewer deliberately requests neither
   * autonomy nor engagement of its own: it produces a verdict, not a product
   * a human signs off, so it inherits the parent's level and can only narrow.
   */
  parent: Pick<ResolvedAgentCompositionV1, "authority" | "autonomy">
  presets: readonly AgentPresetDefinitionV1[]
  promptDigest: string
  toolDigest: string
}

/**
 * Resolve the reviewer's composition.
 *
 * `authority: "plan"` is requested explicitly rather than left to the preset:
 * Minimal's own cap is already `plan`, but stating it here means a future change
 * to the Minimal preset cannot quietly hand the reviewer write access.
 */
export function resolveReviewerComposition(input: ReviewerCompositionInput): UndigestedComposition {
  return resolveChildComposition(input.parent, {
    selection: {
      presetId: REVIEWER_PRESET_ID,
      authority: "plan",
      toolPresentation: "native",
      orchestration: "direct",
    },
    presets: input.presets,
    promptDigest: input.promptDigest,
    toolDigest: input.toolDigest,
  })
}

/** The reviewer's file policy: the authoring root, read-only, always. */
export function reviewerFilePolicy(root: AuthoringRoot): FileAccessPolicy {
  return authoringRootPolicy(root, { readOnly: true })
}

/**
 * What the reviewer is given.
 *
 * Deliberately a closed set. There is no field for the authoring conversation,
 * because "independent context" is enforced by the shape of this brief rather
 * than by asking the caller to remember not to pass the transcript.
 */
export interface ReviewerBrief {
  artifactKind: CreatorArtifactKind
  /** Root-relative paths the run produced. */
  changedPaths: readonly string[]
  permissionDiff: CreatorPermissionDiff
  /** The requirements as recorded at step 1, not the generator's plan. */
  requirements: string
  /** Results of step 6, so the reviewer does not re-run the toolchain. */
  verification: {
    lint: boolean
    typecheck: boolean
    build: boolean
    contract: boolean
  }
}

export function buildReviewerBrief(input: ReviewerBrief): ReviewerBrief {
  return {
    artifactKind: input.artifactKind,
    changedPaths: [...input.changedPaths].sort(),
    permissionDiff: input.permissionDiff,
    requirements: input.requirements,
    verification: { ...input.verification },
  }
}

/**
 * Fold findings into a verdict.
 *
 * Any blocker fails the review, and so does a failed verification step: a
 * reviewer that approved an artifact whose typecheck did not pass would let a
 * broken artifact reach the delivery gate on the strength of a model's opinion.
 */
export function computeReviewVerdict(
  brief: Pick<ReviewerBrief, "verification">,
  findings: readonly CreatorReviewFinding[],
  reviewerAuthority: string
): CreatorReviewVerdict {
  const verificationPassed = Object.values(brief.verification).every(Boolean)
  const hasBlocker = findings.some((finding) => finding.severity === "blocker")
  return {
    approved: verificationPassed && !hasBlocker,
    findings: [...findings],
    reviewerAuthority,
  }
}
