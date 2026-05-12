/**
 * Common helper for the 12 `action.github.*` node executors.
 *
 * Each node:
 *   1. Resolves params (repo + action-specific fields).
 *   2. Acquires Octokit for the repo via the shared runtime.
 *   3. (Optional) Asks the policy-gate to allow the action; on deny, the
 *      executor returns `output.skipped = true` with the deny reason.
 *   4. Calls Octokit.
 *   5. Writes an audit row via the runtime.
 *
 * This file factors out the boilerplate so each node is a thin wrapper
 * around an `octokit.request(...)` call.
 */

import type { Octokit } from "@octokit/core"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type {
  GhAction,
  GhAuditEntry,
  GhPolicy,
} from "@/lib/github/types"
import { requireGithubRuntime } from "./runtime"

export interface GuardedExecutorContext<TParams> {
  step: StepExecutionContext<TParams>
  octokit: Octokit
  repoFullName: string
}

export interface GuardedExecutorOptions<TParams, TOutput> {
  /** Extract the canonical `owner/name` repo full name from params. */
  repoFrom: (params: TParams) => string
  /**
   * Build the GhAction for policy evaluation. Return `null` for read-only
   * actions (e.g. generateChangelog) that should bypass policy entirely.
   */
  action: (params: TParams) => GhAction | null
  /** Read action-level policy override from params (may be undefined). */
  policyOverride?: (params: TParams) => Partial<GhPolicy> | undefined
  /** Actually call Octokit. */
  run: (g: GuardedExecutorContext<TParams>) => Promise<TOutput>
}

/**
 * Build a NodeExecuteFn that handles repo / octokit / policy / audit boilerplate.
 */
export function guardedExecutor<TParams, TOutput>(
  opts: GuardedExecutorOptions<TParams, TOutput>
): (step: StepExecutionContext<Record<string, unknown>>) => Promise<StepExecutionResult> {
  return async (
    rawStep: StepExecutionContext<Record<string, unknown>>
  ): Promise<StepExecutionResult> => {
    const step = rawStep as unknown as StepExecutionContext<TParams>
    const runtime = requireGithubRuntime()
    const repoFullName = opts.repoFrom(step.params)
    if (!repoFullName) {
      throw new Error(`${step.stepId}: repo full name is required`)
    }

    // Policy gate (skip for null actions — read-only).
    const action = opts.action(step.params)
    if (action) {
      const { decision, effectivePolicy } = await runtime.checkPolicy(
        action,
        opts.policyOverride?.(step.params)
      )
      await runtime.recordAudit({
        repoFullName,
        runId: step.runId,
        stepId: step.stepId,
        action,
        decision,
        at: Date.now(),
        reason: decision.allow ? "policy allowed" : decision.reason,
      })
      void effectivePolicy
      if (!decision.allow) {
        return {
          output: {
            skipped: true,
            reason: decision.reason,
            mustWait: decision.mustWait,
          },
        }
      }
    }

    const octokit = await runtime.getOctokit(repoFullName)
    try {
      const out = await opts.run({ step, octokit, repoFullName })
      // Record success audit when an action was attempted (already done above
      // for the allow leg). For read-only actions log an info-level audit.
      if (!action) {
        const readonlyAudit: GhAuditEntry = {
          repoFullName,
          runId: step.runId,
          stepId: step.stepId,
          action: { kind: "comment", body: "[read-only]" },
          decision: { allow: true },
          at: Date.now(),
          reason: "read-only action",
        }
        await runtime.recordAudit(readonlyAudit)
      }
      return { output: out }
    } catch (err) {
      step.log("error", `github: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }
}

/** Split a "owner/name" string. Throws on malformed input. */
export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) throw new Error(`bad repo full name "${fullName}"`)
  return { owner, repo }
}
