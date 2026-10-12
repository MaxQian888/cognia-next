/**
 * The command, as GitHub has it now.
 *
 * Read again at the start of an answer and again before publishing, never
 * from a memoised step: a deleted or edited comment, or an author who has
 * since lost access, must stop the work even after it was queued or
 * approved. Polling cannot see deletions at all, so this read is also how a
 * polled command learns it was deleted.
 */

import {
  checkCommandAuthor,
  GithubRequestError,
  type CommandAuthorDecision,
  type GithubReader,
} from "@cognia/github-bot-kit"

import {
  fromIssueComment,
  fromReview,
  fromReviewComment,
  sha256Hex,
  type CommandSourceV1,
  type IssueCommentPayload,
  type ReviewCommentPayload,
  type ReviewPayload,
} from "./command-source"
import type { Config } from "./config"

export type SourceCheck =
  { status: "current" } | { status: "deleted" } | { status: "superseded" } | { status: "expired" }

function sourcePath(source: SourceIdentity): string {
  switch (source.sourceKind) {
    case "issue_comment":
      return `/issues/comments/${source.sourceId}`
    case "review_comment":
      return `/pulls/comments/${source.sourceId}`
    case "review":
      return `/pulls/${source.threadNumber}/reviews/${source.sourceId}`
  }
}

/** What a re-check needs: the command's identity and version, not what it asked. */
export type SourceIdentity = Pick<
  CommandSourceV1,
  "sourceKind" | "sourceId" | "threadNumber" | "actor" | "sourceRevision" | "sourceBodyHash"
>

export async function recheckSource(
  reader: GithubReader,
  source: SourceIdentity,
  config: Pick<Config, "commandMaxAgeMs">,
  now: () => number = Date.now,
  /** Validity is about when work starts; a decision may take days, publishing stays allowed. */
  options: { checkAge: boolean } = { checkAge: true }
): Promise<SourceCheck> {
  let data: unknown
  try {
    data = (await reader.request<unknown>(sourcePath(source))).data
  } catch (error) {
    if (error instanceof GithubRequestError && (error.status === 404 || error.status === 410))
      return { status: "deleted" }
    throw error
  }
  const current =
    source.sourceKind === "issue_comment"
      ? fromIssueComment(data as IssueCommentPayload, { number: source.threadNumber })
      : source.sourceKind === "review_comment"
        ? fromReviewComment(data as ReviewCommentPayload, source.threadNumber)
        : fromReview(data as ReviewPayload, source.threadNumber)
  if (
    !current ||
    current.user.id !== source.actor.id ||
    current.revision !== source.sourceRevision ||
    (await sha256Hex(current.body)) !== source.sourceBodyHash
  )
    return { status: "superseded" }
  if (options.checkAge && now() - Date.parse(source.sourceRevision) > config.commandMaxAgeMs)
    return { status: "expired" }
  return { status: "current" }
}

/** Thrown when GitHub could not be asked; the delivery retries with backoff. */
export class AuthorCheckUnavailableError extends Error {
  constructor(readonly decision: Extract<CommandAuthorDecision, { outcome: "unavailable" }>) {
    super(`Could not verify the command author's access (${decision.reason})`)
    this.name = "AuthorCheckUnavailableError"
  }
}

/** Allowed, or denied with a reason; an unanswerable check throws instead of guessing. */
export async function authorizeAuthor(
  reader: GithubReader,
  actor: CommandSourceV1["actor"],
  config: Pick<Config, "allowedAuthorIds">
): Promise<Exclude<CommandAuthorDecision, { outcome: "unavailable" }>> {
  const decision = await checkCommandAuthor(reader, actor, config.allowedAuthorIds)
  if (decision.outcome === "unavailable") throw new AuthorCheckUnavailableError(decision)
  return decision
}
