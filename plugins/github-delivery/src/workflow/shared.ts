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
import type { GhAction, GhAuditEntry, GhPolicy } from "@/lib/github/types"
import { requireGithubRuntime } from "./runtime"
import { requestHitlApproval, type HitlApprovalResult } from "../approval/draft-bridge"

export interface GuardedExecutorContext<TParams> {
  step: StepExecutionContext<TParams>
  octokit: Octokit
  repoFullName: string
  /**
   * Populated when the action was suspended for HITL approval and the user
   * approved with edits. Run implementations that respect this — e.g. PR
   * comment executors — should prefer `approval.editedBody` over the
   * proposed body in their `step.params`.
   */
  approval?: HitlApprovalResult
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
  /**
   * Optional short human-readable description of the proposed action for
   * the HITL approval card ("Merge PR #42 in foo/bar"). Defaults to
   * `${action.kind} ${repoFullName}` when omitted.
   */
  describe?: (params: TParams, action: GhAction) => string
  /**
   * Optional proposed comment / review body for HITL approval. When
   * present, the draft is editable and `approval.editedBody` is forwarded
   * to `run` so executors can post the user's revised text.
   */
  proposedBody?: (params: TParams, action: GhAction) => string | undefined
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
    let approval: HitlApprovalResult | undefined
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
        if (decision.needsApproval) {
          // Surface a HITL draft in the Inbox and block until the user
          // approves or rejects it. Approval implies the action is good
          // to run; we skip a second policy round-trip because the user
          // is the override.
          const describeFn = opts.describe ?? ((_p, a) => `${a.kind} ${repoFullName}`)
          const summary = describeFn(step.params, action)
          step.log("info", `github: awaiting HITL approval — ${summary}`)
          approval = await requestHitlApproval({
            runId: step.runId,
            stepId: step.stepId,
            repoFullName,
            actionSummary: summary,
            proposedBody: opts.proposedBody?.(step.params, action),
            signal: step.signal,
          })
          if (approval.outcome === "reject") {
            await runtime.recordAudit({
              repoFullName,
              runId: step.runId,
              stepId: step.stepId,
              action,
              decision: { allow: false, reason: "user rejected HITL approval" },
              at: Date.now(),
              reason: approval.feedback ?? "user rejected",
            })
            return {
              output: {
                skipped: true,
                reason: `HITL rejected: ${approval.feedback ?? "no feedback"}`,
                draftId: approval.draftId,
              },
            }
          }
          // approve — log the approval as an allow audit row for the
          // history view and fall through to execute the action.
          await runtime.recordAudit({
            repoFullName,
            runId: step.runId,
            stepId: step.stepId,
            action,
            decision: { allow: true },
            at: Date.now(),
            reason: `HITL approved (draft ${approval.draftId})`,
          })
        } else {
          return {
            output: {
              skipped: true,
              reason: decision.reason,
              mustWait: decision.mustWait,
            },
          }
        }
      }
    }

    const octokit = await runtime.getOctokit(repoFullName)
    try {
      const out = await opts.run({ step, octokit, repoFullName, approval })
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
