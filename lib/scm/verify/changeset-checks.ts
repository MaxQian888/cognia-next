/**
 * Required checks of a changeset or an integration candidate (ADR-0227 §2, §3).
 *
 * A check here IS an ADR-0188 acceptance run, through the very port Router +
 * Fusion uses (`createDelegateAcceptancePort`). Everything that makes that
 * report worth believing is inherited, not reimplemented: the command is the
 * one the user approved at its hash, it runs in the strongest sandbox tier
 * that can take the worktree with no network, the report is collected from the
 * declared path rather than taken from the agent's word, and a tier that did
 * not attest its confinement is refused.
 *
 * What this adds is the binding to Git. A result is recorded against the SHA
 * whose tree was tested, and the host refuses to count it for any other — so
 * a pass on v1 cannot be presented for v2, which is DEL-03 again at the
 * changeset level.
 *
 * Only `passed` passes. A refusal (no sandbox, unapproved profile, revision
 * not staged) is recorded `inconclusive` with its code: nothing about the code
 * was learned, and the gate must say so rather than let it through.
 */

import type { AcceptancePort, AcceptanceRunOutcome } from "@cognia/router-fusion"

import { ACCEPTANCE_LOG_TAIL_CHARS } from "@/lib/router-fusion/verify/code-acceptance-host"

import type { ChangesetCheck, ChangesetCheckOutcome } from "../types"

export interface RunChangesetChecksInput {
  port: AcceptancePort
  /** Run id the acceptance logs are filed under (the changeset or integration id). */
  runId: string
  /** The commit whose tree the port's `rootForRevision` resolves to a worktree. */
  revision: string
  /** Acceptance profile ids, from the review policy's `requiredChecks`. */
  profileIds: readonly string[]
  signal: AbortSignal
  now?: () => number
}

function clip(text: string): string {
  return text.length <= ACCEPTANCE_LOG_TAIL_CHARS ? text : text.slice(-ACCEPTANCE_LOG_TAIL_CHARS)
}

/** `tier=os ...` from the `sandbox_confinement` check the port appends. */
function tierOf(outcome: Extract<AcceptanceRunOutcome, { kind: "report" }>): string | null {
  const confinement = outcome.report.checks.find(
    (check) => check.check_id === "sandbox_confinement"
  )
  const match = confinement?.summary.match(/(?:^|\s)tier=(\S+)/)
  return match?.[1] ?? null
}

function summaryOf(outcome: Extract<AcceptanceRunOutcome, { kind: "report" }>): string {
  return outcome.report.checks
    .filter((check) => check.check_id !== "sandbox_confinement")
    .map((check) => `[${check.status}] ${check.check_id}: ${check.summary}`)
    .join("\n")
}

export function checkFromOutcome(
  profileId: string,
  revision: string,
  outcome: AcceptanceRunOutcome,
  ranAt: number
): ChangesetCheck {
  if (outcome.kind === "refused") {
    return {
      headSha: revision,
      profileId,
      outcome: "inconclusive",
      tier: null,
      reportDigest: null,
      logTail: clip(`${outcome.code}: ${outcome.message}`),
      ranAt,
    }
  }
  // A report about a different revision is not evidence about this one.
  if (outcome.report.revision !== null && outcome.report.revision !== revision) {
    return {
      headSha: revision,
      profileId,
      outcome: "inconclusive",
      tier: tierOf(outcome),
      reportDigest: outcome.report.report_id,
      logTail: clip(`report names revision ${outcome.report.revision}, expected ${revision}`),
      ranAt,
    }
  }
  const status = outcome.report.status
  const mapped: ChangesetCheckOutcome =
    status === "passed" ? "passed" : status === "failed" ? "failed" : "inconclusive"
  return {
    headSha: revision,
    profileId,
    outcome: mapped,
    tier: tierOf(outcome),
    reportDigest: outcome.report.report_id,
    logTail: clip(summaryOf(outcome)),
    ranAt,
  }
}

/** Run every profile, in order, and record each against `revision`. */
export async function runChangesetChecks(
  input: RunChangesetChecksInput
): Promise<ChangesetCheck[]> {
  const now = input.now ?? Date.now
  const checks: ChangesetCheck[] = []
  for (const profileId of input.profileIds) {
    if (input.signal.aborted) break
    let outcome: AcceptanceRunOutcome
    try {
      outcome = await input.port.runProfile({
        runId: input.runId,
        logicalStepId: `scm-check:${profileId}`,
        profileId,
        revision: input.revision,
        signal: input.signal,
      })
    } catch (error) {
      outcome = {
        kind: "refused",
        code: "ACCEPTANCE_RUN_THREW",
        message: error instanceof Error ? error.message : String(error),
      }
    }
    checks.push(checkFromOutcome(profileId, input.revision, outcome, now()))
  }
  return checks
}

/** Profiles of `required` with no `passed` result at `revision`. */
export function unmetChecks(
  required: readonly string[],
  checks: readonly ChangesetCheck[],
  revision: string
): string[] {
  return required.filter(
    (profileId) =>
      !checks.some(
        (check) =>
          check.profileId === profileId && check.headSha === revision && check.outcome === "passed"
      )
  )
}
