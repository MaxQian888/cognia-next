/**
 * Runtime glue for the Agent Team PR feedback loop: assembles a
 * {@link PrFeedbackController} from the concrete team dependencies (GitHub
 * client, Dexie persistence, the team notifier + mailbox, optional auto-publish
 * and reviewer) into a small handle the runtime drives — `trackAll` after the
 * task DAG, `settle` for the bounded observe window, and `dispose` in `finally`.
 *
 * The notifier / mailbox are injected as narrow callbacks so this module stays
 * decoupled from the store types and is testable with a fake octokit + Dexie.
 */

import { getDb } from "@/lib/db/schema"
import {
  getTeamPrObservation,
  recordTeamPrObservation,
  teamPrObservationId,
  type TeamPrObservationRow,
} from "@/lib/db/team-pr-observations"
import { fetchPrObservation } from "@/lib/github/pr-observe/fetch"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import type { AgentTeamConfig } from "@/types/agent/agent-team"
import { bindingRef, type TeammatePrBinding } from "./binding"
import {
  createRealPrFeedbackTimers,
  PrFeedbackController,
  type PrFeedbackDeps,
  type PrObservationRecord,
} from "./observer"
import { publishTeammatePr, type PublishGitOps } from "./publish"
import type { PrNudge } from "./reactions"
import { createPrReviewer, type RunReview } from "./reviewer"
import {
  sanitizePromotionSegment,
  type PromotionWorkspaceHandle,
} from "@/lib/ai/agent/team/workspace/promotion"

/** Narrow notifier callback (maps to `TeamNotifier.notify` at the call site). */
export interface PrFeedbackNotifyInput {
  level: "info" | "warn"
  title: string
  body: string
  runId: string
  teamId: string
  dedupeKey: string
}

/** Narrow mailbox callback (maps to `TeamStoreWriter.addMessage` at the call site). */
export interface PrFeedbackMailboxInput {
  teamId: string
  senderId: "system"
  recipientId: string
  type: "system"
  content: string
  structuredPayload: { type: "nudge"; nudgeType: "review_pickup"; generation: number }
}

export interface BuildTeamPrFeedbackParams {
  runId: string
  teamId: string
  /** Lead member id — the mailbox recipient for nudges (re-dispatches). */
  leadId?: string
  /** "owner/name". */
  repo: string
  /** Base branch PRs target (auto-publish). */
  baseBranch: string
  octokit: OctokitLike
  config: NonNullable<AgentTeamConfig["prFeedback"]>
  nudges?: AgentTeamConfig["nudges"]
  teammates: Array<{ id: string; name: string }>
  tasks: Array<{ id: string; title?: string }>
  notify: (n: PrFeedbackNotifyInput) => void
  addMessage: (m: PrFeedbackMailboxInput) => void
  /** Git push seam for auto-publish (real impl wraps `gitPush`). */
  git: PublishGitOps
  /** Reviewer seam (dispatchStructured-backed); required when reviewer.enabled. */
  runReview?: RunReview
  /** Injectable timers (tests); defaults to real timers. */
  timers?: Pick<PrFeedbackDeps, "now" | "setTimer" | "clearTimer">
  /** Surface fetch/publish errors (default: swallow). */
  onError?: (binding: TeammatePrBinding, err: unknown) => void
}

/** Handle the runtime drives: track bindings, bound the window, dispose. */
export interface TeamPrFeedback {
  controller: PrFeedbackController
  trackAll: (handles: PromotionWorkspaceHandle[]) => Promise<void>
  settle: (maxWaitMs: number) => Promise<void>
  dispose: () => void
}

export function buildTeamPrFeedback(params: BuildTeamPrFeedbackParams): TeamPrFeedback {
  const {
    runId,
    teamId,
    leadId,
    repo,
    baseBranch,
    octokit,
    config,
    nudges,
    teammates,
    tasks,
    notify,
    addMessage,
    git,
    runReview,
    onError,
  } = params
  const timers = params.timers ?? createRealPrFeedbackTimers()

  const nameOf = (memberId: string): string =>
    teammates.find((t) => t.id === memberId)?.name ?? memberId

  const deliver = (binding: TeammatePrBinding, nudge: PrNudge): void => {
    notify({
      level: "info",
      title: "PR feedback routed",
      body: `${nameOf(binding.memberId)} was nudged to address ${nudge.category} feedback on the PR.`,
      runId,
      teamId,
      dedupeKey: `prnudge:${runId}:${nudge.key}:${nudge.generation}`,
    })
    addMessage({
      teamId,
      senderId: "system",
      recipientId: leadId || binding.memberId,
      type: "system",
      content: nudge.message,
      structuredPayload: {
        type: "nudge",
        nudgeType: "review_pickup",
        generation: nudge.generation,
      },
    })
  }

  const persist = async (record: PrObservationRecord): Promise<void> => {
    const prUrl = record.observation.pr.url || record.binding.prUrl || record.binding.branch
    const at = record.observation.observedAt
    const row: TeamPrObservationRow = {
      id: teamPrObservationId(runId, prUrl),
      runId,
      teamId,
      teammateId: record.binding.memberId,
      taskId: record.binding.taskId,
      prUrl,
      branch: record.binding.branch,
      repo,
      facts: record.observation,
      derivedStatus: record.derivedStatus,
      lastNudgeSignature: record.signature,
      observedAt: at,
      updatedAt: at,
    }
    await recordTeamPrObservation(row)
  }

  const loadSignature: PrFeedbackDeps["loadSignature"] = async (binding) => {
    if (!binding.prUrl) return undefined
    const existing = await getTeamPrObservation(teamPrObservationId(runId, binding.prUrl))
    return existing?.lastNudgeSignature
  }

  const reviewer = config.reviewer?.enabled && runReview ? createPrReviewer(runReview) : undefined

  const controller = new PrFeedbackController({
    ...timers,
    pollIntervalMs: config.pollIntervalMs ?? 30_000,
    fetch: (binding, prev) =>
      fetchPrObservation(octokit, repo, bindingRef(binding), prev, timers.now()),
    persist,
    deliver,
    loadSignature,
    ...(reviewer ? { reviewer } : {}),
    ...(onError ? { onError } : {}),
    maxPerHour: nudges?.maxPerMemberPerHour,
    busyWindowMs: nudges?.busySignalWindowMs,
  })

  const trackAll = async (handles: PromotionWorkspaceHandle[]): Promise<void> => {
    for (const h of handles) {
      const memberId =
        teammates.find(
          (t) => sanitizePromotionSegment(t.name) === sanitizePromotionSegment(h.teammateName)
        )?.id ??
        leadId ??
        h.teammateName
      let binding: TeammatePrBinding = {
        runId,
        teamId,
        memberId,
        taskId: h.taskId,
        repo,
        branch: h.branch,
      }
      if (config.publishPr) {
        try {
          const title =
            tasks.find((t) => t.id === h.taskId)?.title ?? `Agent team change (${h.taskId})`
          const published = await publishTeammatePr(octokit, git, {
            repo,
            branch: h.branch,
            baseBranch,
            worktreePath: h.path,
            title: `[agent-team] ${title}`,
          })
          if (published) binding = { ...binding, prNumber: published.number, prUrl: published.url }
        } catch (err) {
          onError?.(binding, err)
        }
      }
      controller.track(binding)
    }
  }

  return {
    controller,
    trackAll,
    settle: (ms) => controller.settle(ms),
    dispose: () => controller.dispose(),
  }
}

/** Ensure the Dexie schema is open before the first observation write. */
export async function ensureTeamPrObservationsReady(): Promise<void> {
  await getDb().open()
}
