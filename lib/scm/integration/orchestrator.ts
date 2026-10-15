/**
 * Drives one integration through the host's queue (ADR-0227 §2).
 *
 * The host owns every git operation and every state; this owns the order and
 * the two decisions that need the renderer's ports:
 *
 * - **Verification of the exact candidate.** The required acceptance checks
 *   run against the candidate SHA in the integration worktree, through the
 *   same ADR-0188 port a changeset's checks use, and are recorded against
 *   that SHA. Publish is refused by the host unless they passed there.
 * - **Recovery.** A publish refused because the target moved rebuilds on the
 *   new tip and verifies again, a bounded number of times. A candidate that
 *   fails verification with several changesets in it drops the most recently
 *   composed one, rebuilds and re-verifies, until one culprit is isolated and
 *   the rest integrate — or nothing is left. A conflict-only or failed run is
 *   aborted so its changesets return to the queue.
 *
 * Nothing here retries a refusal it does not understand: an uncoded host
 * error, an ineligible changeset, a dirty checked-out target. Those come back
 * to the person, who is the only one who can fix them.
 */

import type { AcceptancePort } from "@cognia/router-fusion"

import { scmErrorCode, type ScmHost } from "../host"
import {
  composedItems,
  type IntegrationAnalysis,
  type IntegrationConflictPolicy,
  type IntegrationRun,
  type IntegrationStrategy,
  type PrepareIntegration,
} from "../types"
import { runChangesetChecks, unmetChecks } from "../verify/changeset-checks"

/** Publishes refused because the target moved, retried at most this many times. */
export const MAX_STALE_REBUILDS = 3

export interface IntegrateChangesetsInput {
  changesetIds: string[]
  targetRef: string
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** Profiles the candidate must pass: the target policy's plus every changeset's. */
  requiredChecks: string[]
  provisioning?: PrepareIntegration["provisioning"]
  signal: AbortSignal
}

export interface IntegrateChangesetsDeps {
  host: ScmHost
  /**
   * The acceptance port, given the run so its `rootForRevision` can answer
   * the candidate's worktree. Null when no port can be built; a run with
   * required checks then never publishes.
   */
  acceptancePortFor: ((run: IntegrationRun) => AcceptancePort) | null
  now?: () => number
}

export type IntegrationOutcomeKind =
  /** The target moved to the verified candidate. */
  | "published"
  /** Nothing could be composed: every changeset conflicted, or stop-on-conflict hit one. */
  | "conflicted"
  /** Verification failed and no subset of the changesets passed. */
  | "failed"
  /** The run was refused or stopped for a reason a person must resolve. */
  | "blocked"

export interface IntegrationOutcome {
  kind: IntegrationOutcomeKind
  analysis: IntegrationAnalysis
  run: IntegrationRun | null
  /** Changesets dropped as the culprit of a failed verification, in drop order. */
  dropped: string[]
  /** Host error code (or `checks_unmet`, `aborted`) when `blocked`/`failed`. */
  reason?: string
  message?: string
}

/** The run's own `rootForRevision`: the candidate lives in its integration worktree. */
export function integrationRootForRevision(
  run: Pick<IntegrationRun, "candidateSha" | "worktreePath">
) {
  return async (revision: string): Promise<string | null> =>
    run.candidateSha && revision === run.candidateSha ? run.worktreePath : null
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message)
  return String(error)
}

export async function integrateChangesets(
  input: IntegrateChangesetsInput,
  deps: IntegrateChangesetsDeps
): Promise<IntegrationOutcome> {
  const { host } = deps
  const now = deps.now ?? Date.now
  const dropped: string[] = []

  const analysis = await host.analyzeIntegration(input.changesetIds, input.targetRef)
  if (analysis.cycles.length > 0) {
    return { kind: "blocked", analysis, run: null, dropped, reason: "cycles" }
  }

  let run: IntegrationRun
  try {
    run = await host.prepareIntegration({
      changesetIds: analysis.order,
      requiredChecks: input.requiredChecks,
      targetRef: input.targetRef,
      strategy: input.strategy,
      onConflict: input.onConflict,
      ...(input.provisioning ? { provisioning: input.provisioning } : {}),
    })
  } catch (error) {
    return {
      kind: "blocked",
      analysis,
      run: null,
      dropped,
      reason: scmErrorCode(error) ?? "host_error",
      message: errorMessage(error),
    }
  }

  let staleRebuilds = 0
  const abortRun = async (current: IntegrationRun): Promise<IntegrationRun> => {
    try {
      return await host.abortIntegration(current.integrationId)
    } catch {
      return current
    }
  }

  for (;;) {
    if (input.signal.aborted) {
      return { kind: "blocked", analysis, run: await abortRun(run), dropped, reason: "aborted" }
    }
    if (run.state === "conflicted" || run.state === "failed") {
      // Nothing composed (all conflicted / all dropped). Give the queue back.
      const kind = run.state === "conflicted" ? "conflicted" : "failed"
      return {
        kind,
        analysis,
        run: await abortRun(run),
        dropped,
        ...(kind === "failed" ? { reason: "checks_unmet" } : {}),
      }
    }
    if (run.state !== "prepared" || !run.candidateSha) {
      return {
        kind: "blocked",
        analysis,
        run,
        dropped,
        reason: "invalid_state",
        message: `integration is ${run.state}`,
      }
    }
    const candidateSha = run.candidateSha
    // The host's list also carries each composed changeset's own checks.
    const requiredChecks = [...new Set([...input.requiredChecks, ...(run.requiredChecks ?? [])])]

    // ── verify the exact candidate ───────────────────────────────────────────
    if (requiredChecks.length > 0) {
      if (!deps.acceptancePortFor) {
        return {
          kind: "blocked",
          analysis,
          run: await abortRun(run),
          dropped,
          reason: "checks_unmet",
          message: "no acceptance port can verify the candidate",
        }
      }
      const checks = await runChangesetChecks({
        port: deps.acceptancePortFor(run),
        runId: `integration:${run.integrationId}`,
        revision: candidateSha,
        profileIds: requiredChecks,
        signal: input.signal,
        now,
      })
      for (const check of checks) {
        run = await host.recordIntegrationCheck(run.integrationId, candidateSha, check)
      }
      const unmet = unmetChecks(requiredChecks, run.checks, candidateSha)
      if (unmet.length > 0) {
        const composed = composedItems(run)
        const culprit = composed[composed.length - 1]
        if (!culprit) {
          return {
            kind: "failed",
            analysis,
            run: await abortRun(run),
            dropped,
            reason: "checks_unmet",
          }
        }
        // Drop the last composed changeset: if the rest pass, it was the one;
        // if they do not, the next iteration drops the one before it.
        run = await host.dropIntegrationItem(run.integrationId, culprit.changesetId)
        dropped.push(culprit.changesetId)
        if (run.state === "stale") run = await host.rebuildIntegration(run.integrationId)
        continue
      }
    }

    // ── publish by compare-and-swap ──────────────────────────────────────────
    try {
      run = await host.publishIntegration(run.integrationId, candidateSha, requiredChecks)
      return { kind: "published", analysis, run, dropped }
    } catch (error) {
      const code = scmErrorCode(error)
      if (
        (code === "target_moved" || code === "stale_candidate") &&
        staleRebuilds < MAX_STALE_REBUILDS
      ) {
        staleRebuilds += 1
        const current = await host.getIntegration(run.integrationId)
        if (!current) throw error
        run = current.state === "stale" ? await host.rebuildIntegration(run.integrationId) : current
        continue
      }
      return {
        kind: "blocked",
        analysis,
        run: (await host.getIntegration(run.integrationId)) ?? run,
        dropped,
        reason: code ?? "host_error",
        message: errorMessage(error),
      }
    }
  }
}
