/**
 * Cross-repository review publishing.
 *
 * ADR-0111 §6: "Cross-repository publish is one branch/PR per repository,
 * grouped into one delivery unit in the UI; no cross-repository network
 * atomicity is claimed." This module IS that delivery unit. It does not try to
 * make N repositories succeed or fail together — it makes each one's outcome
 * legible and independently retryable, which is the guarantee that was actually
 * ratified.
 *
 * Three properties it exists to hold:
 *
 *  1. **No comment reaches a repository it was not anchored to.** The bundle is
 *     sliced by anchor (`bundle.ts`) and the adapter re-checks the slice before
 *     it sends anything.
 *  2. **A failure in one root leaves the others published.** Legs are
 *     independent; one throwing does not abort the rest.
 *  3. **A retry touches only what failed.** Re-running with the previous
 *     delivery carries succeeded legs forward untouched, so a second press
 *     cannot double-post to a repository that already took the review.
 *
 * Legs run SEQUENTIALLY. Two or three repositories is the realistic case, the
 * requests are writes against one API's rate limit, and a failure part-way
 * through is easier to reason about when the remaining legs have not already
 * been fired.
 */

import { PullRequestProviderError } from "./github-provider"
import { anchoredRoots, sliceBundleByRoot } from "./bundle"
import { normalizeReviewPath } from "./contracts"
import type {
  PullRequestProvider,
  PullRequestRef,
  ReviewDelivery,
  ReviewDeliveryLeg,
  ReviewFeedbackBundle,
} from "@/types/review"

/** Where one root's comments go. */
export interface ReviewDeliveryTarget {
  repositoryRoot: string
  pullRequest: PullRequestRef
}

export interface PublishReviewInput {
  provider: PullRequestProvider
  bundle: ReviewFeedbackBundle
  targets: readonly ReviewDeliveryTarget[]
  /**
   * A previous attempt. Its succeeded legs are carried forward and NOT re-sent;
   * only failed and pending legs are attempted again.
   */
  previous?: ReviewDelivery
  now?: number
}

function targetFor(
  targets: readonly ReviewDeliveryTarget[],
  root: string
): PullRequestRef | undefined {
  return targets.find((target) => normalizeReviewPath(target.repositoryRoot) === root)?.pullRequest
}

function errorLeg(root: string, commentCount: number, error: unknown): ReviewDeliveryLeg {
  const message = error instanceof Error ? error.message : String(error)
  const recoverable = error instanceof PullRequestProviderError ? error.recoverable : false
  const uncertain = error instanceof PullRequestProviderError ? error.outcomeUncertain : false
  return {
    repositoryRoot: root,
    status: "failed",
    commentCount,
    error: { message, recoverable },
    ...(uncertain ? { outcomeUncertain: true } : {}),
  }
}

/**
 * Publish one bundle across every repository its comments touch.
 *
 * Never throws for a leg failure — a thrown delivery would discard the record
 * of which repositories already succeeded, which is the one thing the caller
 * needs in order to retry safely.
 */
export async function publishReviewFeedback(input: PublishReviewInput): Promise<ReviewDelivery> {
  const now = input.now ?? Date.now()
  const slices = sliceBundleByRoot(input.bundle)
  const roots = anchoredRoots(input.bundle)
  const settled = new Map(
    (input.previous?.legs ?? [])
      .filter((leg) => leg.status === "succeeded")
      .map((leg) => [normalizeReviewPath(leg.repositoryRoot), leg])
  )

  const legs: ReviewDeliveryLeg[] = []
  for (const root of roots) {
    const slice = slices.get(root)
    // `anchoredRoots` derives from the same comments, so a missing slice is
    // impossible; the guard is here so a future change cannot turn it into an
    // undefined dereference that silently skips a repository.
    if (!slice) continue
    const commentCount = slice.comments.length
    // `root` is the normalized comparison key; the slice carries the anchor's
    // real path. Legs record the latter — it is what a person reads and what a
    // retry hands back to git.
    const rootPath = slice.repositoryRoots[0] ?? root

    const already = settled.get(root)
    if (already) {
      legs.push({ ...already, status: "succeeded", commentCount })
      continue
    }

    const pullRequest = targetFor(input.targets, root)
    if (!pullRequest) {
      // Not a failure of this delivery: the user wrote comments on a root they
      // never opened a pull request for. Saying "skipped" keeps the comments
      // and names what is missing, where "failed" would suggest a retry.
      legs.push({
        repositoryRoot: rootPath,
        status: "skipped",
        commentCount,
        error: { message: `No pull request is selected for ${rootPath}`, recoverable: false },
      })
      continue
    }

    try {
      await input.provider.publishFeedback(pullRequest, slice)
      legs.push({ repositoryRoot: rootPath, status: "succeeded", commentCount, pullRequest })
    } catch (error) {
      legs.push({ ...errorLeg(rootPath, commentCount, error), pullRequest })
    }
  }

  return {
    bundleId: input.bundle.id,
    legs,
    startedAt: input.previous?.startedAt ?? now,
    updatedAt: now,
  }
}

/** Legs a retry would actually re-send. */
export function retryableLegs(delivery: ReviewDelivery): ReviewDeliveryLeg[] {
  return delivery.legs.filter((leg) => leg.status === "failed")
}

/**
 * Legs whose replay might duplicate a review that already landed.
 *
 * The UI must say so before offering the retry: GitHub's review endpoint has no
 * idempotency key, so a leg that never received a response cannot be replayed
 * without the possibility of posting the same review twice.
 */
export function uncertainLegs(delivery: ReviewDelivery): ReviewDeliveryLeg[] {
  return delivery.legs.filter((leg) => leg.outcomeUncertain === true)
}
