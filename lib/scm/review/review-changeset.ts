/**
 * The review gate of one changeset (ADR-0227 §3), in order:
 *
 * 1. the review policy, read at the TARGET ref (never from the change);
 * 2. deterministic change risk over the changeset's files;
 * 3. the review agent over the pinned base → head diff, unless the policy
 *    turns it off;
 * 4. the required acceptance checks, run against the head's worktree;
 *
 * then ONE review record and one check record per profile, each bound to the
 * head SHA the host holds. The host recomputes eligibility from those records;
 * nothing here can declare a changeset eligible.
 *
 * A human approval is not a flag on the automatic review: `approveChangeset`
 * records a review by the user AND the head-bound approval, so the person who
 * approved is the reviewer of record, with the risk the automatic pass found.
 */

import type { AcceptancePort } from "@cognia/router-fusion"

import type { ScmHost } from "../host"
import type {
  AgentChangeset,
  ChangesetCheck,
  ChangesetReview,
  ChangesetReviewVerdict,
} from "../types"
import { runChangesetChecks } from "../verify/changeset-checks"
import {
  assessChangeRisk,
  type ChangeRiskAssessment,
  type ChangeRiskReason,
} from "./assess-change-risk"
import {
  reviewChangesetWithAgent,
  type ReviewAgentDeps,
  type ReviewAgentOutcome,
} from "./review-agent"
import { readReviewPolicyAtRef, type ReadBlobAtRef, type ReviewPolicy } from "./review-policy"

export interface ReviewChangesetDeps {
  host: ScmHost
  readBlob: ReadBlobAtRef
  agent: ReviewAgentDeps
  /**
   * The acceptance port for this changeset's project, or null when the
   * caller cannot provide one (no project, web build). Required checks then
   * record `inconclusive`: the gate stays shut and says why.
   */
  acceptancePort: AcceptancePort | null
  signal: AbortSignal
  now?: () => number
}

export interface ChangesetReviewResult {
  changeset: AgentChangeset
  /** Null when the target's policy was invalid; the review then owes a human. */
  policy: ReviewPolicy | null
  risk: ChangeRiskAssessment | null
  agent: ReviewAgentOutcome | null
  checks: ChangesetCheck[]
}

/** One stable string per reason, for the review record and the UI's translation. */
export function reasonKey(reason: ChangeRiskReason): string {
  return reason.category ? `${reason.code}:${reason.category}` : reason.code
}

/** Every profile the change owes: its own plus the target policy's. */
export function requiredChecksFor(
  changeset: Pick<AgentChangeset, "requiredChecks">,
  policy: ReviewPolicy | null
): string[] {
  return [...new Set([...changeset.requiredChecks, ...(policy?.requiredChecks ?? [])])]
}

/** Fold the deterministic risk and the agent outcome into one verdict. */
export function combineVerdict(
  policy: ReviewPolicy,
  agent: ReviewAgentOutcome | null
): { verdict: ChangesetReviewVerdict; reviewer: ChangesetReview["reviewer"] } {
  if (!agent) return { verdict: "approve", reviewer: "deterministic" }
  if (agent.verdict === "requestChanges") return { verdict: "requestChanges", reviewer: "agent" }
  if (agent.verdict === "unavailable") {
    return policy.reviewAgent === "required"
      ? { verdict: "unavailable", reviewer: "agent" }
      : { verdict: "approve", reviewer: "deterministic" }
  }
  return { verdict: "approve", reviewer: "agent" }
}

const REVIEWABLE: ReadonlySet<AgentChangeset["state"]> = new Set([
  "draft",
  "ready",
  "approved",
  "changesRequested",
])

export async function reviewChangeset(
  changesetId: string,
  deps: ReviewChangesetDeps
): Promise<ChangesetReviewResult> {
  const now = deps.now ?? Date.now
  let changeset = await deps.host.getChangeset(changesetId)
  if (!changeset) throw new Error(`changeset ${changesetId} not found`)
  if (!REVIEWABLE.has(changeset.state)) {
    throw new Error(`changeset ${changesetId} is ${changeset.state} and cannot be reviewed`)
  }
  if (changeset.state === "draft") changeset = await deps.host.markChangesetReady(changesetId)
  const headSha = changeset.headSha

  const resolution = await readReviewPolicyAtRef(
    changeset.sourceRoot,
    changeset.targetRef,
    deps.readBlob
  )
  if (!resolution.ok) {
    // A policy nobody can parse is not "no policy": fail closed to a human.
    const review: ChangesetReview = {
      headSha,
      verdict: "unavailable",
      reviewer: "deterministic",
      riskTier: "high",
      reasons: [
        "reviewPolicyInvalid",
        ...resolution.problems.map((problem) => `reviewPolicyInvalid:${problem.code}`),
      ],
      findings: [],
      requiresHumanApproval: true,
      recordedAt: now(),
    }
    changeset = await deps.host.recordChangesetReview(changesetId, review)
    return { changeset, policy: null, risk: null, agent: null, checks: [] }
  }
  const policy = resolution.policy

  const risk = assessChangeRisk(changeset.files, policy)
  const agent =
    policy.reviewAgent === "off"
      ? null
      : await reviewChangesetWithAgent(
          {
            repoPath: changeset.sourceRoot,
            baseSha: changeset.baseSha,
            headSha,
            files: changeset.files,
          },
          deps.agent
        )
  const { verdict, reviewer } = combineVerdict(policy, agent)
  const reasons = risk.reasons.map(reasonKey)
  if (agent?.unavailableReason) reasons.push(`reviewAgentUnavailable:${agent.unavailableReason}`)
  if (agent?.redacted) reasons.push("reviewAgentRedacted")

  const review: ChangesetReview = {
    headSha,
    verdict,
    reviewer,
    riskTier: risk.tier,
    reasons,
    findings: agent?.findings ?? [],
    requiresHumanApproval: risk.requiresHumanApproval || verdict === "unavailable",
    recordedAt: now(),
  }
  changeset = await deps.host.recordChangesetReview(changesetId, review)

  const profiles = requiredChecksFor(changeset, policy)
  let checks: ChangesetCheck[] = []
  if (profiles.length > 0) {
    checks = deps.acceptancePort
      ? await runChangesetChecks({
          port: changesetAcceptancePort(deps.acceptancePort, changeset),
          runId: `changeset:${changesetId}`,
          revision: headSha,
          profileIds: profiles,
          signal: deps.signal,
          now,
        })
      : profiles.map((profileId) => ({
          headSha,
          profileId,
          outcome: "inconclusive" as const,
          tier: null,
          reportDigest: null,
          logTail: "ACCEPTANCE_PORT_UNAVAILABLE: no acceptance port for this changeset's project",
          ranAt: now(),
        }))
    for (const check of checks) changeset = await deps.host.recordChangesetCheck(changesetId, check)
  }
  return { changeset, policy, risk, agent, checks }
}

/**
 * The port as seen from one changeset: it only verifies the changeset's own
 * head. Callers build the port with `rootForRevision` from
 * {@link changesetRootForRevision}; this wrapper refuses any other revision
 * before the port is asked, so a check can never run against a tree the
 * changeset did not pin.
 */
function changesetAcceptancePort(port: AcceptancePort, changeset: AgentChangeset): AcceptancePort {
  return {
    runProfile: (request) =>
      request.revision === changeset.headSha
        ? port.runProfile(request)
        : Promise.resolve({
            kind: "refused",
            code: "ACCEPTANCE_REVISION_UNAVAILABLE",
            message: `changeset ${changeset.changesetId} pins ${changeset.headSha}, not ${request.revision}`,
          }),
  }
}

/**
 * `rootForRevision` for a changeset: its execution root holds the head's tree
 * (the capture was just taken from it; sensitive files the capture withheld
 * are the only difference, and the acceptance sandbox mounts no credentials).
 */
export function changesetRootForRevision(
  changeset: Pick<AgentChangeset, "headSha" | "executionRoot">
) {
  return async (revision: string): Promise<string | null> =>
    revision === changeset.headSha ? changeset.executionRoot : null
}

/**
 * A human approves the head they looked at. Records the user as reviewer of
 * record (keeping the risk the automatic pass found) and the head-bound
 * approval. Refused by the host when `headSha` is no longer the head.
 */
export async function approveChangeset(
  host: ScmHost,
  changeset: AgentChangeset,
  approver: string,
  now: () => number = Date.now
): Promise<AgentChangeset> {
  const previous = changeset.review
  const review: ChangesetReview = {
    headSha: changeset.headSha,
    verdict: "approve",
    reviewer: "user",
    riskTier: previous?.riskTier ?? "low",
    reasons: previous?.reasons ?? [],
    findings: previous?.findings ?? [],
    requiresHumanApproval: true,
    recordedAt: now(),
  }
  await host.recordChangesetReview(changeset.changesetId, review)
  return host.approveChangeset(changeset.changesetId, changeset.headSha, approver)
}

/** A human asks for changes on the head they looked at. */
export async function requestChangesetChanges(
  host: ScmHost,
  changeset: AgentChangeset,
  note: string | null,
  now: () => number = Date.now
): Promise<AgentChangeset> {
  const previous = changeset.review
  return host.recordChangesetReview(changeset.changesetId, {
    headSha: changeset.headSha,
    verdict: "requestChanges",
    reviewer: "user",
    riskTier: previous?.riskTier ?? "low",
    reasons: previous?.reasons ?? [],
    findings: [
      ...(previous?.findings ?? []),
      ...(note ? [{ path: "", severity: "critical" as const, note }] : []),
    ],
    requiresHumanApproval: previous?.requiresHumanApproval ?? false,
    recordedAt: now(),
  })
}
