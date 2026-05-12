/**
 * Shared runtime services for the github-delivery workflow nodes.
 *
 * The plugin's `activate()` calls {@link setGithubRuntime} with an octokit
 * factory + table accessors + audit writer. The 12 `action.github.*`
 * executors read from this singleton via {@link requireGithubRuntime}.
 *
 * This module is intentionally simple — no DI container, no lifecycle hooks.
 * The plugin manager guarantees `activate()` runs before any workflow can
 * dispatch a github node, and `deactivate()` clears the singleton.
 */

import type { Octokit } from "@octokit/core"
import type {
  GhAction,
  GhAuditEntry,
  GhPolicy,
  GhRepoEntry,
  PolicyDecision,
} from "@/lib/github/types"

export interface GithubRuntime {
  /** Look up a repo registration. Returns null if not configured. */
  getRepo(fullName: string): Promise<GhRepoEntry | null>
  /** Acquire an Octokit instance for the given repo. */
  getOctokit(fullName: string): Promise<Octokit>
  /** Persist an audit row (allow / deny). */
  recordAudit(row: GhAuditEntry): Promise<void>
  /**
   * Evaluate the policy gate for an action against the repo's policy.
   * Implementations layer node-level policy overrides on top of the repo's
   * stored default, run quietHours / branchProtection / etc, and return
   * the final decision. {@link recordAudit} is invoked by the caller.
   */
  checkPolicy(
    action: GhAction,
    overrides?: Partial<GhPolicy>
  ): Promise<{ decision: PolicyDecision; effectivePolicy: GhPolicy }>
}

let _runtime: GithubRuntime | null = null

export function setGithubRuntime(rt: GithubRuntime | null): void {
  _runtime = rt
}

export function getGithubRuntime(): GithubRuntime | null {
  return _runtime
}

export function requireGithubRuntime(): GithubRuntime {
  if (!_runtime) {
    throw new Error(
      "GitHub Delivery runtime is not initialized. Activate the github-delivery plugin first."
    )
  }
  return _runtime
}
