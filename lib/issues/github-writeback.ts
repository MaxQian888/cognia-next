/**
 * Write-back for mirrored GitHub issues — comment, label, close.
 *
 * Deliberately ZERO new GitHub write paths. Every mutation routes through the
 * `github-delivery` plugin's existing `commentIssue` / `labelIssue` /
 * `closeIssue` actions, which means it inherits, for free:
 *
 *   - the integration account + credential resolution,
 *   - the PII gate on the outbound request body (`hasNoLeakingPiiDeep` in
 *     `lib/integrations/action-runner.ts`),
 *   - the audit trail, retry policy and per-account concurrency cap,
 *   - the `awaiting_approval` gate that every non-read action starts in.
 *
 * That last one is the load-bearing part. `executeIntegrationAction` parks any
 * `write`/`destructive` action in `awaiting_approval`; nothing here approves it
 * unless the caller passes `approval: "user-confirmed"`, which the UI only does
 * after the confirmation dialog has shown the user the exact payload. An
 * irreversible external write must never happen on a stray click.
 */

import {
  approveIntegrationActionJob,
  executeIntegrationAction,
} from "@/lib/integrations/action-runner"
import { listIntegrationAccounts } from "@/lib/db/integrations"
import { GITHUB_DOT_COM } from "@/lib/github/host"
import { githubReadAccountsFor } from "@/lib/integrations/github-read-credential"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"

export const GITHUB_DELIVERY_PLUGIN_ID = "github-delivery"
export const GITHUB_INTEGRATION_ID = "github"

/**
 * The three write-backs the board offers. Intentionally not "edit title" or
 * "reassign": those have no local equivalent to keep in step, and the board
 * greys them out via `READ_ONLY_ISSUE_CAPABILITIES` rather than pretending.
 */
export type GithubWritebackAction =
  | { kind: "comment"; body: string }
  | { kind: "label"; labels: readonly string[] }
  | { kind: "close"; reason?: "completed" | "not_planned" }

export interface GithubWritebackTarget {
  repoFullName: string
  number: number
}

/** Raised for every refusal the user can act on, with a machine-readable code. */
export class GithubWritebackError extends Error {
  readonly code: "no-account" | "plugin-unavailable" | "rejected"

  constructor(code: "no-account" | "plugin-unavailable" | "rejected", message: string) {
    super(message)
    this.name = "GithubWritebackError"
    this.code = code
    // Restores `instanceof` after a downlevel transform — see the same note in
    // `sync-runner.ts`.
    Object.setPrototypeOf(this, GithubWritebackError.prototype)
  }
}

/**
 * Issue bindings currently name public GitHub repositories. Reuse the read
 * path's host and owner selection so a newer GHES account cannot redirect a
 * write to its same-named repository. A confirmed account never falls back to
 * another account if it was removed, disabled, or disconnected meanwhile.
 */
export async function resolveGithubWritebackAccount(
  repoFullName = "",
  accountId?: string
): Promise<IntegrationAccount | null> {
  const accounts = await githubReadAccountsFor(repoFullName, GITHUB_DOT_COM, {
    listAccounts: () => listIntegrationAccounts(GITHUB_DELIVERY_PLUGIN_ID, GITHUB_INTEGRATION_ID),
    hostForSession: async (sessionId) => {
      const { githubHostForSession } = await import("@/lib/integrations/github-auth")
      return githubHostForSession(sessionId)
    },
  })
  return accounts.find((account) => accountId === undefined || account.id === accountId) ?? null
}

/** Action id + payload for the underlying integration action. */
export function toIntegrationAction(
  target: GithubWritebackTarget,
  action: GithubWritebackAction
): { actionId: string; input: Record<string, unknown> } {
  const base = { repoFullName: target.repoFullName, issueNumber: target.number }
  switch (action.kind) {
    case "comment":
      return { actionId: "commentIssue", input: { ...base, body: action.body } }
    case "label":
      return { actionId: "labelIssue", input: { ...base, labels: [...action.labels] } }
    case "close":
      return {
        actionId: "closeIssue",
        input: { ...base, reason: action.reason ?? "completed" },
      }
  }
}

export interface RunGithubWritebackInput {
  target: GithubWritebackTarget
  action: GithubWritebackAction
  /** The account shown in the confirmation dialog, when there is one. */
  accountId?: string
  /**
   * Present ONLY when a human has confirmed this exact write in a dialog that
   * showed them the payload. Omitting it leaves the job parked in
   * `awaiting_approval` for the integrations approval surface to pick up.
   */
  approval?: "user-confirmed"
  /** Stable key so a retry of the same write is deduplicated upstream. */
  idempotencyKey?: string
}

export interface RunGithubWritebackDeps {
  resolveAccount?: typeof resolveGithubWritebackAccount
  execute?: typeof executeIntegrationAction
  approve?: typeof approveIntegrationActionJob
}

export async function runGithubWriteback(
  input: RunGithubWritebackInput,
  deps: RunGithubWritebackDeps = {}
): Promise<IntegrationActionJob> {
  const resolveAccount = deps.resolveAccount ?? resolveGithubWritebackAccount
  const execute = deps.execute ?? executeIntegrationAction
  const approve = deps.approve ?? approveIntegrationActionJob

  const account = await resolveAccount(input.target.repoFullName, input.accountId)
  if (!account || (input.accountId !== undefined && account.id !== input.accountId)) {
    throw new GithubWritebackError(
      "no-account",
      "No enabled GitHub account is connected; connect one in Settings → Connections."
    )
  }

  const { actionId, input: actionInput } = toIntegrationAction(input.target, input.action)

  let job: IntegrationActionJob
  try {
    job = await execute(GITHUB_DELIVERY_PLUGIN_ID, {
      integrationId: GITHUB_INTEGRATION_ID,
      accountId: account.id,
      actionId,
      input: actionInput,
      source: "manual",
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    })
  } catch (cause) {
    // The commonest cause by far is the plugin not being enabled, which reads
    // as an opaque "Integration is not registered" without this translation.
    throw new GithubWritebackError(
      "plugin-unavailable",
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  if (job.status === "awaiting_approval" && input.approval === "user-confirmed") {
    return approve(job.id)
  }
  return job
}

export interface CreateGithubIssueInput {
  repoFullName: string
  title: string
  body?: string
  /**
   * Stable per (local issue, repository): a retry of the same publish is
   * deduplicated by the action runner instead of opening a second issue.
   */
  idempotencyKey: string
}

export interface CreatedGithubIssue {
  repoFullName: string
  number: number
  htmlUrl: string
  /** Epoch ms of the remote's `updated_at`, when GitHub reported one. */
  updatedAt?: number
}

/**
 * Open a GitHub issue through the `github-delivery` `createIssue` action.
 *
 * Only ever called after a person confirmed the exact title and body in a
 * dialog, so the job is approved in the same step — the same contract as
 * `runGithubWriteback` with `approval: "user-confirmed"`. Anything short of a
 * completed job (the plugin refused, GitHub failed) is an error, because the
 * caller links the local issue to the result and there is no result to link.
 */
export async function createGithubIssue(
  input: CreateGithubIssueInput,
  deps: RunGithubWritebackDeps = {}
): Promise<CreatedGithubIssue> {
  const resolveAccount = deps.resolveAccount ?? resolveGithubWritebackAccount
  const execute = deps.execute ?? executeIntegrationAction
  const approve = deps.approve ?? approveIntegrationActionJob

  const account = await resolveAccount(input.repoFullName)
  if (!account) {
    throw new GithubWritebackError(
      "no-account",
      "No enabled GitHub account is connected; connect one in Settings → Connections."
    )
  }

  let job: IntegrationActionJob
  try {
    job = await execute(GITHUB_DELIVERY_PLUGIN_ID, {
      integrationId: GITHUB_INTEGRATION_ID,
      accountId: account.id,
      actionId: "createIssue",
      input: {
        repoFullName: input.repoFullName,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
      },
      source: "manual",
      idempotencyKey: input.idempotencyKey,
    })
  } catch (cause) {
    throw new GithubWritebackError(
      "plugin-unavailable",
      cause instanceof Error ? cause.message : String(cause)
    )
  }
  if (job.status === "awaiting_approval") job = await approve(job.id)
  const output = job.output as
    { number?: unknown; html_url?: unknown; updated_at?: unknown } | undefined
  if (job.status !== "succeeded" || typeof output?.number !== "number") {
    throw new GithubWritebackError(
      "rejected",
      job.error ?? `GitHub did not create the issue (job ${job.status})`
    )
  }
  const updatedAt = typeof output.updated_at === "string" ? Date.parse(output.updated_at) : NaN
  return {
    repoFullName: input.repoFullName,
    number: output.number,
    htmlUrl:
      typeof output.html_url === "string"
        ? output.html_url
        : `https://github.com/${input.repoFullName}/issues/${output.number}`,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }
}
