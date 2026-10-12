/**
 * Every GitHub write this Bot makes, in one shape: an approval for the exact
 * action and input, then the brokered action under that approval.
 *
 * Automatic publication is the host's existing policy mode, not a bypass: the
 * installation must hold an autopilot grant without
 * `requireApprovalForWrites`, and the host still records the decision for the
 * exact content. Approval mode asks a person. Either way the broker re-checks
 * the approval, the action allowlist and the repository scope, and runs the
 * PII gate over what is written.
 *
 * The intent time is recorded before the first attempt and travels as
 * `since`, so the Delivery action can find an earlier copy of a comment whose
 * POST succeeded but whose response was lost.
 */

import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"

import type { CommandSourceV1 } from "./command-source"
import type { Config } from "./config"
import { GITHUB_SLOT } from "./identity"

/**
 * The host parks or cancels a run by throwing through the handler. A handler
 * that catches broadly must let these pass, or a run waiting on a person
 * would carry on as if the write had been refused.
 */
export function isRunControlFlow(error: unknown, signal?: AbortSignal): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return Boolean(signal?.aborted) || name === "BotRunParkedError" || name === "BotRunCancelledError"
}

export type WriteActionId =
  "commentIssue" | "commentPr" | "replyToReviewComment" | "updateComment" | "reviewPr"

export interface ApprovedWrite {
  /** Stable, unique within the run; names the decision and the write steps. */
  step: string
  actionId: WriteActionId
  input: Record<string, unknown>
  /** Unique per publication; the broker deduplicates jobs on it. */
  idempotencyKey: string
  title: string
  message: string
  detail?: Record<string, unknown>
  /** A marked comment action gets `since` for reconcile. */
  reconcile?: boolean
}

export type WriteDecision =
  | { outcome: "approved"; approvalId: string; input: Record<string, unknown> }
  | { outcome: "denied" | "expired" | "cancelled" }

/** Seven days, the host's ordinary ceiling for a parked publication decision. */
const DECISION_TIMEOUT_MS = 7 * 24 * 60 * 60_000
/** Clock skew allowed between this host and GitHub when searching for an earlier copy. */
const RECONCILE_SKEW_MS = 5 * 60_000

export async function decideWrite(
  run: BotRunContextV1,
  config: Config,
  write: ApprovedWrite,
  now = Date.now
): Promise<WriteDecision> {
  const intentAt = await run.step.run(`${write.step}:intent`, () => now())
  const input = write.reconcile
    ? { ...write.input, since: new Date(intentAt - RECONCILE_SKEW_MS).toISOString() }
    : write.input
  const decision = await run.step.waitForApproval(`${write.step}:decision`, {
    decisionMode: config.publicationMode === "automatic" ? "policy" : "human",
    title: write.title,
    message: write.message,
    risk: "medium",
    timeoutMs: DECISION_TIMEOUT_MS,
    detail: {
      ...write.detail,
      repository: config.repository,
      approvedActions: [{ actionId: write.actionId, input }],
    },
  })
  if (decision.outcome !== "approved") return { outcome: decision.outcome }
  if (!decision.approvalId) throw new Error("Host did not return a verifiable approval reference")
  return { outcome: "approved", approvalId: decision.approvalId, input }
}

export interface WriteReceipt {
  jobId: string
  remote: unknown
}

export async function executeWrite(
  ctx: PluginContext,
  run: BotRunContextV1,
  write: ApprovedWrite,
  decision: Extract<WriteDecision, { outcome: "approved" }>
): Promise<WriteReceipt> {
  return run.step.run(`${write.step}:write`, async () => {
    const job = await ctx.integrations.executeAction({
      integrationId: "github",
      // The broker resolves the account from the run's binding; a Bot is never
      // told which account that is, so empty is the only value it accepts.
      accountId: "",
      binding: { runId: run.runId, slotId: GITHUB_SLOT },
      approval: { interruptId: decision.approvalId },
      actionId: write.actionId,
      input: decision.input,
      idempotencyKey: write.idempotencyKey,
      source: "workflow",
    })
    if (job.status !== "succeeded")
      throw new Error(`GitHub write ${job.status}: ${job.error ?? job.id}`)
    return { jobId: job.id, remote: job.output }
  })
}

/** The public URL of a written comment or review, when GitHub returned one. */
export function remoteUrl(remote: unknown): string | undefined {
  const url = (remote as { html_url?: unknown } | null)?.html_url
  return typeof url === "string" && /^https:\/\//.test(url) ? url : undefined
}

export function remoteId(remote: unknown): number | undefined {
  const id = (remote as { id?: unknown } | null)?.id
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * Where a reply to a command goes: into the line thread it was written in,
 * otherwise the issue or pull request conversation. The body must carry
 * `marker`, which also makes the comment reconcilable.
 */
export function replyAction(
  source: Pick<
    CommandSourceV1,
    "repository" | "threadKind" | "threadNumber" | "sourceKind" | "sourceId"
  >,
  body: string,
  marker: string
): { actionId: WriteActionId; input: Record<string, unknown> } {
  if (source.sourceKind === "review_comment")
    return {
      actionId: "replyToReviewComment",
      input: {
        repoFullName: source.repository,
        prNumber: source.threadNumber,
        commentId: Number(source.sourceId),
        body,
        marker,
      },
    }
  return conversationAction(source, body, marker)
}

/** A new comment in the issue or pull request conversation. */
export function conversationAction(
  source: Pick<CommandSourceV1, "repository" | "threadKind" | "threadNumber">,
  body: string,
  marker: string
): { actionId: WriteActionId; input: Record<string, unknown> } {
  return source.threadKind === "pull_request"
    ? {
        actionId: "commentPr",
        input: { repoFullName: source.repository, prNumber: source.threadNumber, body, marker },
      }
    : {
        actionId: "commentIssue",
        input: { repoFullName: source.repository, issueNumber: source.threadNumber, body, marker },
      }
}
