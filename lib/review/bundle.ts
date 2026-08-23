/**
 * Splitting a review bundle along repository lines.
 *
 * A `ReviewFeedbackBundle` is authored across every selected root at once —
 * that is what makes it one review to the person writing it. Publishing is the
 * opposite: ADR-0111 §6 ratified one branch/PR per repository, with no
 * cross-repository atomicity claimed. This module is the seam between the two.
 *
 * It exists because the alternative was what shipped: `publishFeedback` took
 * `bundle.repositoryRoots[0]` and posted the whole comment list against that
 * one repository. A comment written on `packages/api/src/db.ts` in the second
 * root was posted to the FIRST root's pull request, against whatever file
 * happened to sit at that path there — or against nothing, silently.
 */

import { normalizeReviewPath } from "./contracts"
import type { ReviewComment, ReviewFeedbackBundle } from "@/types/review"

/** The root a comment belongs to, normalized the same way its anchor was. */
export function commentRoot(comment: ReviewComment): string {
  return normalizeReviewPath(comment.anchor.repositoryRoot)
}

/**
 * Every root the bundle's comments are actually anchored to.
 *
 * Deliberately derived from the COMMENTS, not from `repositoryRoots`: the
 * latter records what the user had selected when they opened the review, which
 * routinely includes roots they then wrote nothing about. Publishing to those
 * would open an empty review on a repository nobody commented on.
 */
export function anchoredRoots(bundle: ReviewFeedbackBundle): string[] {
  const roots = new Set<string>()
  for (const comment of bundle.comments) {
    if (comment.status === "stale") continue
    roots.add(commentRoot(comment))
  }
  return [...roots].sort()
}

/**
 * One single-root bundle per repository, keyed by normalized root.
 *
 * Each slice keeps the shared summary and identity — it is still one review to
 * the reader — but carries only its own comments and names only its own root,
 * which is the shape `publishFeedback` requires.
 *
 * The KEY is normalized; the slice's `repositoryRoots[0]` is the anchor's own
 * path, verbatim. `normalizeReviewPath` exists so `C:\repo` and `c:/repo`
 * compare equal — it is a comparison form, not a filesystem path, and
 * `publishFeedback` passes that value to `resolveRepository`, which shells git
 * at it. Storing the normalized form on the slice leaked the comparison
 * transform into the I/O layer.
 */
export function sliceBundleByRoot(bundle: ReviewFeedbackBundle): Map<string, ReviewFeedbackBundle> {
  const slices = new Map<string, ReviewFeedbackBundle>()
  for (const comment of bundle.comments) {
    if (comment.status === "stale") continue
    const root = commentRoot(comment)
    const existing = slices.get(root)
    if (existing) {
      existing.comments.push(comment)
      continue
    }
    slices.set(root, {
      ...bundle,
      repositoryRoots: [comment.anchor.repositoryRoot],
      comments: [comment],
    })
  }
  return slices
}

/**
 * Assert a bundle is publishable against exactly `repositoryRoot`.
 *
 * Returns the comments that belong to it. Throws — rather than filtering
 * quietly — when the bundle names a different or additional root, because a
 * caller that reached here with a multi-root bundle has a bug, and silently
 * dropping the other roots' comments would lose review a person wrote.
 */
export function assertSingleRootBundle(
  bundle: ReviewFeedbackBundle,
  repositoryRoot: string
): ReviewComment[] {
  const root = normalizeReviewPath(repositoryRoot)
  if (bundle.repositoryRoots.length !== 1) {
    throw new Error(
      `Review feedback must name exactly one repository root to publish; got ${bundle.repositoryRoots.length}`
    )
  }
  const declared = normalizeReviewPath(bundle.repositoryRoots[0])
  if (declared !== root) {
    throw new Error(`Review feedback is for ${declared}, not ${root}`)
  }
  const live = bundle.comments.filter((comment) => comment.status !== "stale")
  const foreign = live.filter((comment) => commentRoot(comment) !== root)
  if (foreign.length > 0) {
    throw new Error(`Review feedback carries ${foreign.length} comment(s) anchored outside ${root}`)
  }
  return live
}
