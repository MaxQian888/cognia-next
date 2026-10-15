/**
 * `merge-all` for an Agent Team run (ADR-0227 §5): every successful
 * teammate's detached environment becomes a changeset, each changeset goes
 * through the review gate, and the ones that pass are integrated by the
 * host's queue — one transaction per repository, verified as composed,
 * published by compare-and-swap.
 *
 * ADR-0111 left this mode refused because no host-side transaction existed;
 * the queue is that transaction, so this module only decides WHAT goes in:
 *
 * - **Order.** Changesets are captured in task-dependency order, so each one
 *   declares the changesets of the tasks it depends on, and the host composes
 *   them in that order (and refuses a cycle).
 * - **Who waits.** A changeset that owes a human approval, or whose review
 *   asked for changes, is not integrated unattended. Neither is anything that
 *   depends on it. They come back in the result for the person.
 * - **Where it lands.** By default a branch this run creates,
 *   `agent/<run>/integrated`, starting at the source checkout's HEAD — an
 *   unattended team never moves a branch nobody named. `target: "base"`
 *   integrates into the branch the source checkout is on, and only when it is
 *   on one.
 */

import type { ChangesetReviewResult } from "@/lib/scm/review/review-changeset"
import { requiredChecksFor } from "@/lib/scm/review/review-changeset"
import type {
  IntegrateChangesetsInput,
  IntegrationOutcome,
} from "@/lib/scm/integration/orchestrator"
import { scmErrorCode, type ScmHost } from "@/lib/scm/host"
import type {
  AgentChangeset,
  IntegrationConflictPolicy,
  IntegrationStrategy,
} from "@/lib/scm/types"

import { sanitizePromotionSegment } from "./promotion"

export type AgentTeamIntegrationTarget = "branch" | "base"

export interface AgentTeamIntegrationConfig {
  target: AgentTeamIntegrationTarget
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** Profiles every changeset of the run owes, on top of each target's policy. */
  requiredChecks: string[]
}

export const DEFAULT_AGENT_TEAM_INTEGRATION: Readonly<AgentTeamIntegrationConfig> = Object.freeze({
  target: "branch",
  strategy: "merge",
  onConflict: "skip",
  requiredChecks: [],
})

/** One teammate's environment in one repository, ready to become a changeset. */
export interface TeamIntegrationCandidate {
  key: string
  taskId: string
  teammateName: string
  logicalRootId: string
  sourceRoot: string
  workspaceId: string
}

export interface AgentTeamIntegrationDeps {
  host: ScmHost
  review: (changesetId: string) => Promise<ChangesetReviewResult>
  integrate: (input: IntegrateChangesetsInput) => Promise<IntegrationOutcome>
  /** Current branch of a checkout, or null when HEAD is detached. */
  currentBranch: (sourceRoot: string) => Promise<string | null>
  /** Create `name` at `from` without checking it out; resolves when it exists. */
  createBranch: (sourceRoot: string, name: string, from: string) => Promise<void>
  /** Whether a local branch exists already. */
  branchExists: (sourceRoot: string, name: string) => Promise<boolean>
  signal: AbortSignal
}

export interface TeamRootIntegrationResult {
  logicalRootId: string
  targetRef: string
  /** Branch this run created to integrate into, when `target` is `branch`. */
  createdBranch: string | null
  outcome: IntegrationOutcome["kind"] | "nothingToIntegrate"
  integrationId: string | null
  resultSha: string | null
  merged: string[]
  conflicted: string[]
  dropped: string[]
  /** Owes a human approval (or depends on one that does). */
  awaitingApproval: string[]
  changesRequested: string[]
  /** Candidates with nothing to capture: the teammate changed nothing. */
  unchanged: string[]
  /** Candidates whose capture or review failed, with the host's code. */
  failed: Array<{ key: string; reason: string }>
  reason?: string
}

export interface AgentTeamIntegrationResult {
  roots: TeamRootIntegrationResult[]
  /** Every changeset this run captured, by candidate key. */
  changesets: Record<string, string>
}

/** `agent/<run>/integrated`, suffixed per repository when the run has several. */
export function integrationBranchName(
  runId: string,
  logicalRootId: string,
  multiRoot: boolean
): string {
  const base = `agent/${sanitizePromotionSegment(runId)}/integrated`
  return multiRoot ? `${base}-${sanitizePromotionSegment(logicalRootId)}` : base
}

/**
 * Candidates in an order where every task comes after the tasks it depends
 * on. A cycle is not broken here: its members keep their input order and the
 * host's analysis reports the cycle.
 */
export function orderByDependencies(
  candidates: readonly TeamIntegrationCandidate[],
  dependencies: Readonly<Record<string, readonly string[]>>
): TeamIntegrationCandidate[] {
  const byTask = new Map<string, TeamIntegrationCandidate[]>()
  for (const candidate of candidates) {
    const list = byTask.get(candidate.taskId) ?? []
    list.push(candidate)
    byTask.set(candidate.taskId, list)
  }
  const ordered: TeamIntegrationCandidate[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (taskId: string) => {
    if (visited.has(taskId) || visiting.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of dependencies[taskId] ?? []) {
      if (byTask.has(dependency)) visit(dependency)
    }
    visiting.delete(taskId)
    visited.add(taskId)
    ordered.push(...(byTask.get(taskId) ?? []))
  }
  for (const candidate of candidates) visit(candidate.taskId)
  return ordered
}

function isWaiting(result: ChangesetReviewResult): "approval" | "changes" | null {
  const review = result.changeset.review
  if (!review || review.headSha !== result.changeset.headSha) return "approval"
  if (review.verdict === "requestChanges") return "changes"
  if (review.verdict !== "approve" || review.requiresHumanApproval) return "approval"
  const unmet = result.changeset.requiredChecks
    .concat(result.policy?.requiredChecks ?? [])
    .some(
      (profile) =>
        !result.changeset.checks.some(
          (check) =>
            check.profileId === profile &&
            check.headSha === result.changeset.headSha &&
            check.outcome === "passed"
        )
    )
  return unmet ? "approval" : null
}

async function resolveTarget(
  runId: string,
  logicalRootId: string,
  sourceRoot: string,
  multiRoot: boolean,
  config: AgentTeamIntegrationConfig,
  deps: AgentTeamIntegrationDeps
): Promise<{ targetRef: string; createdBranch: string | null } | { refused: string }> {
  const current = await deps.currentBranch(sourceRoot)
  if (config.target === "base") {
    if (!current) return { refused: "base_detached" }
    return { targetRef: `refs/heads/${current}`, createdBranch: null }
  }
  const name = integrationBranchName(runId, logicalRootId, multiRoot)
  if (await deps.branchExists(sourceRoot, name)) {
    // A rerun of the same run integrates on top of what it already published.
    return { targetRef: `refs/heads/${name}`, createdBranch: null }
  }
  await deps.createBranch(sourceRoot, name, "HEAD")
  return { targetRef: `refs/heads/${name}`, createdBranch: name }
}

export async function integrateTeamRun(
  runId: string,
  candidates: readonly TeamIntegrationCandidate[],
  dependencies: Readonly<Record<string, readonly string[]>>,
  config: AgentTeamIntegrationConfig,
  deps: AgentTeamIntegrationDeps
): Promise<AgentTeamIntegrationResult> {
  const roots = new Map<string, TeamIntegrationCandidate[]>()
  for (const candidate of candidates) {
    const list = roots.get(candidate.logicalRootId) ?? []
    list.push(candidate)
    roots.set(candidate.logicalRootId, list)
  }
  const multiRoot = roots.size > 1
  const changesetByKey: Record<string, string> = {}
  const results: TeamRootIntegrationResult[] = []

  for (const [logicalRootId, rootCandidates] of roots) {
    const sourceRoot = rootCandidates[0].sourceRoot
    const result: TeamRootIntegrationResult = {
      logicalRootId,
      targetRef: "",
      createdBranch: null,
      outcome: "nothingToIntegrate",
      integrationId: null,
      resultSha: null,
      merged: [],
      conflicted: [],
      dropped: [],
      awaitingApproval: [],
      changesRequested: [],
      unchanged: [],
      failed: [],
    }
    results.push(result)

    const target = await resolveTarget(runId, logicalRootId, sourceRoot, multiRoot, config, deps)
    if ("refused" in target) {
      result.outcome = "blocked"
      result.reason = target.refused
      continue
    }
    result.targetRef = target.targetRef
    result.createdBranch = target.createdBranch

    // ── capture, in dependency order ─────────────────────────────────────────
    const changesetByTask = new Map<string, string[]>()
    const captured: AgentChangeset[] = []
    for (const candidate of orderByDependencies(rootCandidates, dependencies)) {
      if (deps.signal.aborted) break
      const dependsOn = (dependencies[candidate.taskId] ?? []).flatMap(
        (taskId) => changesetByTask.get(taskId) ?? []
      )
      try {
        const changeset = await deps.host.captureChangeset({
          workspaceId: candidate.workspaceId,
          targetRef: target.targetRef,
          title: `${candidate.teammateName}: ${candidate.taskId}`,
          dependsOn,
          requiredChecks: config.requiredChecks,
        })
        captured.push(changeset)
        changesetByKey[candidate.key] = changeset.changesetId
        changesetByTask.set(candidate.taskId, [
          ...(changesetByTask.get(candidate.taskId) ?? []),
          changeset.changesetId,
        ])
      } catch (error) {
        if (scmErrorCode(error) === "nothing_to_capture") result.unchanged.push(candidate.key)
        else
          result.failed.push({
            key: candidate.key,
            reason: scmErrorCode(error) ?? "capture_failed",
          })
      }
    }

    // ── review; hold back what owes a person, and what depends on it ─────────
    const ready = new Set<string>()
    const held = new Set<string>()
    const requiredChecks = new Set(config.requiredChecks)
    const keyOf = (changesetId: string) =>
      Object.keys(changesetByKey).find((key) => changesetByKey[key] === changesetId) ?? changesetId
    for (const changeset of captured) {
      let reviewed: ChangesetReviewResult
      try {
        reviewed = await deps.review(changeset.changesetId)
      } catch (error) {
        result.failed.push({
          key: keyOf(changeset.changesetId),
          reason: scmErrorCode(error) ?? "review_failed",
        })
        held.add(changeset.changesetId)
        continue
      }
      for (const profile of requiredChecksFor(reviewed.changeset, reviewed.policy))
        requiredChecks.add(profile)
      const waiting = isWaiting(reviewed)
      if (waiting === "changes") {
        result.changesRequested.push(changeset.changesetId)
        held.add(changeset.changesetId)
      } else if (waiting === "approval") {
        result.awaitingApproval.push(changeset.changesetId)
        held.add(changeset.changesetId)
      } else {
        ready.add(changeset.changesetId)
      }
    }
    // Anything depending on a held changeset waits with it.
    let changed = true
    while (changed) {
      changed = false
      for (const changeset of captured) {
        if (!ready.has(changeset.changesetId)) continue
        if (
          changeset.dependsOn.some((dependency) => held.has(dependency) || !ready.has(dependency))
        ) {
          ready.delete(changeset.changesetId)
          held.add(changeset.changesetId)
          result.awaitingApproval.push(changeset.changesetId)
          changed = true
        }
      }
    }

    const integrable = captured
      .filter((changeset) => ready.has(changeset.changesetId))
      .map((c) => c.changesetId)
    if (integrable.length === 0 || deps.signal.aborted) continue

    const outcome = await deps.integrate({
      changesetIds: integrable,
      targetRef: target.targetRef,
      strategy: config.strategy,
      onConflict: config.onConflict,
      requiredChecks: [...requiredChecks],
      signal: deps.signal,
    })
    result.outcome = outcome.kind
    result.integrationId = outcome.run?.integrationId ?? null
    result.resultSha = outcome.run?.resultSha ?? null
    result.dropped = outcome.dropped
    if (outcome.reason) result.reason = outcome.reason
    for (const item of outcome.run?.items ?? []) {
      if (
        outcome.kind === "published" &&
        (item.outcome === "merged" || item.outcome === "rerereResolved")
      ) {
        result.merged.push(item.changesetId)
      }
      if (item.outcome === "conflicted") result.conflicted.push(item.changesetId)
    }
  }
  return { roots: results, changesets: changesetByKey }
}
