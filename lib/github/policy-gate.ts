/**
 * Single policy gate. Every bot-driven GitHub mutation flows through here
 * before reaching Octokit. Decisions are emitted as PolicyDecision and (per
 * the plan) MUST be persisted to the audit table by the caller — both allows
 * and denies. We do not write the audit row inside checkPolicy because the
 * runId / stepId / repoFullName context lives in the workflow step.
 */

import { isInQuietHours, msUntilQuietEnd } from "@/lib/connectors/outbound-runner"
import type { GhAction, GhPolicy, GhPolicyContext, PolicyDecision, PrRef, IssueRef } from "./types"

const ALLOW: PolicyDecision = { allow: true }

function deny(reason: string, mustWait?: { until: number }): PolicyDecision {
  return mustWait ? { allow: false, reason, mustWait } : { allow: false, reason }
}

/**
 * Recoverable deny — the caller can resolve it via human approval (Inbox
 * draft). Tagged with `needsApproval: true` so the GitHub Delivery
 * draft-bridge can route it to a HITL flow instead of aborting the step.
 */
function denyAwaitingApproval(reason: string): PolicyDecision {
  return { allow: false, reason, needsApproval: true }
}

function targetRepo(target: PrRef | IssueRef): string {
  return target.repo
}

function pickAuthorPolicy(
  policy: GhPolicy,
  ctx: GhPolicyContext,
  authorLogin?: string
): PolicyDecision {
  if (!authorLogin) return ALLOW // events without an author bypass this layer
  const allowed = policy.allowedAuthors
  switch (allowed.kind) {
    case "explicit":
      return allowed.logins.includes(authorLogin)
        ? ALLOW
        : deny(`author "${authorLogin}" is not in the explicit allow-list`)
    case "collaborators":
    case "members":
      // The lookup of "is X a collaborator/member of repo Y" is done by the
      // workflow step that pre-fetches the data and passes it via
      // ctx.knownAllowedLogins. Here we only enforce the membership rule.
      if (!ctx.knownAllowedLogins) {
        return deny(
          `cannot evaluate "${allowed.kind}" policy: caller did not pass knownAllowedLogins`
        )
      }
      return ctx.knownAllowedLogins.includes(authorLogin)
        ? ALLOW
        : deny(`author "${authorLogin}" is not in the ${allowed.kind} list`)
  }
}

function checkBranchProtection(policy: GhPolicy, branch: string): PolicyDecision {
  const matched = policy.branchProtection.find((re) => new RegExp(re).test(branch))
  if (matched) {
    return deny(`branch "${branch}" matches protection regex "${matched}"`)
  }
  return ALLOW
}

function checkQuietHours(policy: GhPolicy, now: number): PolicyDecision {
  const qh = policy.quietHours
  if (!qh) return ALLOW
  if (!isInQuietHours(now, qh.from, qh.to, qh.tz)) return ALLOW
  const until = msUntilQuietEnd(now, qh.to, qh.tz)
  return deny("quiet hours active", { until: now + until })
}

/**
 * Evaluate `action` against `ctx.policy`. Returns the decision; caller writes
 * the audit row.
 */
export function checkPolicy(action: GhAction, ctx: GhPolicyContext): PolicyDecision {
  const { policy } = ctx

  // Quiet hours suspend all mutating actions uniformly.
  const qh = checkQuietHours(policy, ctx.now)
  if (!qh.allow) return qh

  switch (action.kind) {
    case "merge": {
      if (policy.requireGreenCi && ctx.ciStatus !== "success") {
        return deny(`merge requires CI=success but got "${ctx.ciStatus ?? "unknown"}"`)
      }
      if (policy.requireHumanApproval && !ctx.humanApproved) {
        return denyAwaitingApproval("merge requires explicit human approval")
      }
      if (ctx.mergesTodayCount >= policy.maxDailyMerges) {
        return deny(
          `daily merge cap of ${policy.maxDailyMerges} reached (${ctx.mergesTodayCount} today)`
        )
      }
      const author = pickAuthorPolicy(policy, ctx, ctx.authorLogin)
      if (!author.allow) return author
      return ALLOW
    }

    case "push": {
      const bp = checkBranchProtection(policy, action.branch)
      if (!bp.allow) return bp
      return ALLOW
    }

    case "release": {
      // Drafts are always allowed; only published releases honor approval.
      if (action.draft) return ALLOW
      if (policy.requireHumanApproval && !ctx.humanApproved) {
        return denyAwaitingApproval("publishing a release requires explicit human approval")
      }
      return ALLOW
    }

    case "comment": {
      // Comments are low-risk; only author allow-list applies.
      const author = pickAuthorPolicy(policy, ctx, ctx.authorLogin)
      if (!author.allow) return author
      return ALLOW
    }

    case "label": {
      // Labels are low-risk; only author allow-list applies.
      const author = pickAuthorPolicy(policy, ctx, ctx.authorLogin)
      if (!author.allow) return author
      return ALLOW
    }

    case "close": {
      const author = pickAuthorPolicy(policy, ctx, ctx.authorLogin)
      if (!author.allow) return author
      // Avoid lint warning for unused destructure target.
      void targetRepo(action.target)
      return ALLOW
    }
  }
}

/**
 * Helper: deep-merge a per-node policy override on top of the repo-level
 * default. Arrays are replaced (not concatenated).
 */
export function mergePolicy(base: GhPolicy, override?: Partial<GhPolicy>): GhPolicy {
  if (!override) return base
  return {
    ...base,
    ...override,
    quietHours: override.quietHours ?? base.quietHours,
    allowedLabels: override.allowedLabels ?? base.allowedLabels,
    branchProtection: override.branchProtection ?? base.branchProtection,
    allowedAuthors: override.allowedAuthors ?? base.allowedAuthors,
  }
}
