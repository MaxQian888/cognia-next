/**
 * Internal reviewer agent — a port of agent-orchestrator's `review/`. It runs a
 * review pass over a teammate's PR diff and, when it requests changes, routes a
 * `review_pickup` nudge back to that teammate through the same reaction engine
 * (so it shares dedup + the per-member hourly cap).
 *
 * This module is the pure surface: the reviewer's system/user prompts, the
 * structured verdict schema, the nudge-intent builder, and a `createPrReviewer`
 * adapter that turns a `runReview` seam into the observer's `reviewer` hook. The
 * concrete `dispatchStructured` call (which needs the team run context) is wired
 * in the runtime, keeping this module unit-testable without the team runtime.
 */

import { z } from "zod"
import { sanitizeControlChars } from "@/lib/github/pr-observe/sanitize"
import type { PrObservation } from "@/lib/github/pr-observe/types"
import type { TeammatePrBinding } from "./binding"
import { REVIEW_MAX_NUDGE, type NudgeIntent } from "./reactions"
import type { PrFeedbackDeps } from "./observer"

/** Standing reviewer role (AO's reviewer system prompt, adapted). */
export const REVIEWER_SYSTEM_PROMPT = `You are an internal code reviewer for an AI agent team. Review ONLY the requested pull request's changes — do not start unrelated work and do not modify the branch. Inspect the diff of the PR's head branch against its base branch, and review for correctness bugs, missing error handling, security issues, missing test coverage, and clear deviations from the surrounding code's conventions. Prefer a few high-confidence findings over nitpicks.`

/** Structured verdict the reviewer must return. */
export const reviewerVerdictSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  /** Markdown summary of the review; the specific changes needed when requesting them. */
  body: z.string(),
})

export type ReviewerVerdict = z.infer<typeof reviewerVerdictSchema>

/** Per-PR reviewer task prompt (self-contained; the ids the reviewer needs). */
export function buildReviewerPrompt(obs: PrObservation): string {
  const pr = obs.pr
  return [
    `Review pull request #${pr.number} "${sanitizeControlChars(pr.title)}" in ${obs.repo}.`,
    `Head branch: ${pr.sourceBranch} (commit ${pr.headSha}) → base branch: ${pr.targetBranch}.`,
    `Diff the head branch against the base branch and review the changes.`,
    `Return a JSON verdict: "approved" when the changes are ready to merge, or "changes_requested" with a "body" that summarizes the specific changes needed. Keep the body focused and actionable.`,
  ].join("\n")
}

/**
 * Build the nudge intent for a reviewer verdict. Returns null unless changes were
 * requested. The signature is keyed on the reviewed head SHA + body so a fresh
 * review on a new commit re-fires, but the same verdict does not.
 *
 * INVARIANT (same as {@link import("./reactions").buildNudgeIntents}): the
 * returned `message` is control-char-sanitized but NOT PII-gated, so it MUST be
 * delivered only through `PrReactionEngine.reactIntents` / `sendOnce`.
 */
export function buildReviewerIntent(
  binding: TeammatePrBinding,
  obs: PrObservation,
  verdict: ReviewerVerdict
): NudgeIntent | null {
  if (verdict.verdict !== "changes_requested") return null
  const url = obs.pr.url
  const body = sanitizeControlChars(verdict.body ?? "")
  const message =
    "[AO reviewer] The internal code reviewer requested changes on your PR. Address the feedback and push." +
    (body ? `\n\nReview:\n${body}` : "")
  return {
    key: `review:${url}:ao:${binding.runId}`,
    sig: `${obs.pr.headSha}#${body}`,
    message,
    maxAttempts: REVIEW_MAX_NUDGE,
    category: "review",
  }
}

/** The `runReview` seam: produce a verdict for a PR, or null to skip. */
export type RunReview = (
  binding: TeammatePrBinding,
  obs: PrObservation
) => Promise<ReviewerVerdict | null>

/**
 * Adapt a `runReview` seam into the observer's `reviewer` hook: run the review,
 * then map a changes-requested verdict to a nudge intent (null otherwise).
 */
export function createPrReviewer(runReview: RunReview): NonNullable<PrFeedbackDeps["reviewer"]> {
  return async (binding, obs) => {
    const verdict = await runReview(binding, obs)
    if (!verdict) return null
    return buildReviewerIntent(binding, obs, verdict)
  }
}
