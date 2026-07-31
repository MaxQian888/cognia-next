/**
 * Pure routing decision for an assistant turn that may be an edit to an
 * existing artifact. Extracted from `use-claude-chat` so it can be unit-tested
 * in isolation. Given the review setting, the in-flight edit target, the target
 * artifact's type, and the artifacts detected in the assistant text, it decides
 * whether to stage a pending-review proposal or fall back to auto-creation.
 */

import type { ArtifactType } from "@/types/artifact/artifact"
import type { DetectedArtifact } from "@/lib/ai/generation/artifact-detector"
import type { ArtifactEditTarget } from "@/stores/chat/chat-store"

export interface AiRevisionRouteInput {
  /** Whether the review-before-apply gate is enabled. */
  reviewEnabled: boolean
  /** The edit target recorded at send time (null/undefined when none). */
  target: ArtifactEditTarget | null | undefined
  /** Type of the artifact the edit targets (used to prefer a matching block). */
  targetArtifactType?: ArtifactType
  /** Artifacts detected in the assistant reply. */
  detected: DetectedArtifact[]
}

export type AiRevisionRoute =
  | { action: "propose"; artifactId: string; content: string; requestId: string }
  | { action: "autoCreate" }

const CODE_ISH: ReadonlySet<ArtifactType> = new Set<ArtifactType>(["code", "react", "html", "svg"])

/**
 * Decide how to handle a freshly-sealed assistant turn.
 *
 * Routes to `propose` only when the gate is on, an edit target exists, and the
 * reply contains at least one detected artifact. The block is chosen by:
 *   1. exact type match with the target artifact, else
 *   2. the first code-ish block when the target is code-ish, else
 *   3. the first detected block (the user explicitly aimed this turn at the
 *      target, so the reply is treated as its revision).
 * Otherwise routes to `autoCreate` (existing behavior — never loses content).
 */
export function routeAiRevision(input: AiRevisionRouteInput): AiRevisionRoute {
  const { reviewEnabled, target, targetArtifactType, detected } = input

  if (!reviewEnabled || !target || detected.length === 0) {
    return { action: "autoCreate" }
  }

  const exact = targetArtifactType ? detected.find((d) => d.type === targetArtifactType) : undefined

  const codeish =
    !exact && targetArtifactType && CODE_ISH.has(targetArtifactType)
      ? detected.find((d) => CODE_ISH.has(d.type))
      : undefined

  const chosen = exact ?? codeish ?? detected[0]

  return {
    action: "propose",
    artifactId: target.artifactId,
    content: chosen.content,
    requestId: target.requestId,
  }
}
