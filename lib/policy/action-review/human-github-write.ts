/**
 * The record of a GitHub write a person made by hand (ADR-0239 phase 2).
 *
 * A button whose label says what it writes (publish this stack, merge these
 * pull requests, open the pull request) is the person's own authorization, so
 * the outbound policy never holds it. It still leaves the same trail as a
 * write the policy planned: an `integration-action` receipt on the
 * `github-delivery` channel, `authority: "human"`, actor `local-user`, naming
 * the repositories (by fingerprint) and, as the sender, the surface clicked
 * (`person:<surface>`). Recorded before the write, so a write that fails
 * halfway still shows who started it.
 *
 * Writes through the integration broker do not call this: they pass a
 * `person` caller to `executeIntegrationAction`, which plans and records the
 * same receipt. This is for the paths that write with their own credential
 * (an Octokit, `gh`).
 *
 * Recording never changes the write: a failure is logged and swallowed.
 */

import type {
  ActionReviewDecision,
  ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { unknownGithubTarget, type OutboundTarget } from "./outbound-targets"
import type { PlanIntegrationDeps } from "./plan-integration"

export interface HumanGithubWrite {
  /** The repositories written to (`repositoryTarget` / `repositoryOnHost`). */
  targets: readonly (OutboundTarget | undefined)[]
  /** What is written, for the receipt's title: `github.publishStack`. */
  operation: string
  /** Where the person clicked: `stack-panel`, `review-panel`. */
  surface: string
  /** The session the click belongs to, when there is one. */
  sessionId?: string
}

export interface HumanGithubWriteDeps {
  plan?: PlanIntegrationDeps
  project?: (request: ActionReviewRequest, decision: ActionReviewDecision) => Promise<unknown>
}

/** Record a person's GitHub write; never throws. */
export async function recordHumanGithubWrite(
  write: HumanGithubWrite,
  deps: HumanGithubWriteDeps = {}
): Promise<void> {
  try {
    const named = write.targets.filter((target): target is OutboundTarget => Boolean(target))
    const { planIntegrationWrite } = await import("./plan-integration")
    const decision = await planIntegrationWrite(
      {
        // A repository that could not be named is still recorded as a write.
        targets: named.length > 0 ? named : [unknownGithubTarget()],
        operation: write.operation,
        authorization: {
          kind: "person",
          surface: write.surface,
          ...(write.sessionId ? { sessionId: write.sessionId } : {}),
        },
      },
      deps.plan
    )
    if (!decision.receipt) return
    const project = deps.project ?? (await import("./projection")).projectActionReviewSettled
    await project(decision.receipt.request, decision.receipt.decision)
  } catch (error) {
    console.warn("[outbound] recording a person's GitHub write failed", error)
  }
}
