/**
 * A comment that commands the Bot, as one immutable, versioned record.
 *
 * Webhook and polling produce the same record, so they deduplicate onto the
 * same delivery: its event id is `gh-cmd:<repositoryId>:<kind>:<id>:<revision>`
 * and the Bot plane's dedup key does the rest. Each command source is its own
 * Bot resource, so an edit supersedes exactly that comment's earlier version
 * (`cancelResource(..., exceptRevision)`) and a deletion cancels exactly that
 * comment's work, never a neighbour's in the same thread.
 */

import { parseCommand, type CommandGrammar, type ParsedCommand } from "@cognia/github-bot-kit"

export type SourceKind = "issue_comment" | "review_comment" | "review"
export type ThreadKind = "issue" | "pull_request"

export const COMMAND_VERBS = ["ask", "review", "status", "cancel", "help", "fix", "retry"] as const
export type CommandVerb = (typeof COMMAND_VERBS)[number]
export const RESERVED_VERBS = ["merge", "approve", "release", "exec", "deploy"] as const
/** Largest command comment, in UTF-8 bytes; a larger one is refused with usage. */
export const MAX_COMMAND_BYTES = 16 * 1024
/** The output marker namespace every comment this Bot writes carries. */
export const MARKER_NAMESPACE = "cognia-command"

export function commandGrammar(trigger: string): CommandGrammar {
  return {
    trigger,
    verbs: COMMAND_VERBS,
    reservedVerbs: RESERVED_VERBS,
    freeTextVerb: "ask",
    bareVerb: "help",
    maxBytes: MAX_COMMAND_BYTES,
  }
}

export interface GithubActor {
  id: number
  login: string
  type?: string
}

/** One comment, review comment or review, as GitHub returned it. */
export interface RawCommandComment {
  sourceKind: SourceKind
  id: number
  body: string
  createdAt: string
  /** The version: `updated_at` for comments, `submitted_at` for a review. */
  revision: string
  user: GithubActor
  url?: string
  threadNumber: number
  /** Unknown for a polled issue comment until the issue is read. */
  threadKind?: ThreadKind
  review?: { path?: string; line?: number; commitId?: string; inReplyToId?: number }
}

export interface CommandSourceV1 {
  schemaVersion: 1
  ingress: "webhook" | "poll"
  repositoryId: string
  repository: string
  threadKind: ThreadKind
  threadNumber: number
  sourceKind: SourceKind
  sourceId: string
  sourceRevision: string
  sourceCreatedAt: string
  sourceBodyHash: string
  sourceUrl?: string
  actor: GithubActor
  verb: CommandVerb
  /** The arguments after the verb (or the whole text for an aliased ask). */
  request: string
  aliased: boolean
  review?: RawCommandComment["review"]
}

interface GithubUserPayload {
  id?: unknown
  login?: unknown
  type?: unknown
}

function actorOf(user: GithubUserPayload | null | undefined): GithubActor | undefined {
  if (!user || typeof user.id !== "number" || typeof user.login !== "string") return undefined
  return {
    id: user.id,
    login: user.login,
    ...(typeof user.type === "string" ? { type: user.type } : {}),
  }
}

function numberFromUrl(url: unknown, segment: "issues" | "pulls"): number | undefined {
  if (typeof url !== "string") return undefined
  const match = new RegExp(`/${segment}/([1-9][0-9]*)$`).exec(url)
  return match ? Number(match[1]) : undefined
}

export interface IssueCommentPayload {
  id?: unknown
  body?: unknown
  created_at?: unknown
  updated_at?: unknown
  html_url?: unknown
  issue_url?: unknown
  user?: GithubUserPayload | null
}

export function fromIssueComment(
  comment: IssueCommentPayload,
  thread?: { number?: unknown; pull_request?: unknown }
): RawCommandComment | undefined {
  const user = actorOf(comment.user)
  const threadNumber =
    typeof thread?.number === "number" ? thread.number : numberFromUrl(comment.issue_url, "issues")
  if (
    typeof comment.id !== "number" ||
    typeof comment.created_at !== "string" ||
    typeof comment.updated_at !== "string" ||
    !user ||
    !threadNumber
  )
    return undefined
  return {
    sourceKind: "issue_comment",
    id: comment.id,
    body: typeof comment.body === "string" ? comment.body : "",
    createdAt: comment.created_at,
    revision: comment.updated_at,
    user,
    ...(typeof comment.html_url === "string" ? { url: comment.html_url } : {}),
    threadNumber,
    ...(thread ? { threadKind: thread.pull_request ? "pull_request" : "issue" } : {}),
  }
}

export interface ReviewCommentPayload extends IssueCommentPayload {
  pull_request_url?: unknown
  path?: unknown
  line?: unknown
  original_line?: unknown
  commit_id?: unknown
  in_reply_to_id?: unknown
}

export function fromReviewComment(
  comment: ReviewCommentPayload,
  prNumber?: number
): RawCommandComment | undefined {
  const user = actorOf(comment.user)
  const threadNumber = prNumber ?? numberFromUrl(comment.pull_request_url, "pulls")
  if (
    typeof comment.id !== "number" ||
    typeof comment.created_at !== "string" ||
    typeof comment.updated_at !== "string" ||
    !user ||
    !threadNumber
  )
    return undefined
  const line =
    typeof comment.line === "number"
      ? comment.line
      : typeof comment.original_line === "number"
        ? comment.original_line
        : undefined
  return {
    sourceKind: "review_comment",
    id: comment.id,
    body: typeof comment.body === "string" ? comment.body : "",
    createdAt: comment.created_at,
    revision: comment.updated_at,
    user,
    ...(typeof comment.html_url === "string" ? { url: comment.html_url } : {}),
    threadNumber,
    threadKind: "pull_request",
    review: {
      ...(typeof comment.path === "string" ? { path: comment.path } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(typeof comment.commit_id === "string" ? { commitId: comment.commit_id } : {}),
      ...(typeof comment.in_reply_to_id === "number"
        ? { inReplyToId: comment.in_reply_to_id }
        : {}),
    },
  }
}

export interface ReviewPayload {
  id?: unknown
  body?: unknown
  submitted_at?: unknown
  html_url?: unknown
  commit_id?: unknown
  state?: unknown
  user?: GithubUserPayload | null
}

export function fromReview(review: ReviewPayload, prNumber: number): RawCommandComment | undefined {
  const user = actorOf(review.user)
  if (
    typeof review.id !== "number" ||
    typeof review.submitted_at !== "string" ||
    !user ||
    // A pending review is the author's draft, not something they said.
    review.state === "PENDING"
  )
    return undefined
  return {
    sourceKind: "review",
    id: review.id,
    body: typeof review.body === "string" ? review.body : "",
    createdAt: review.submitted_at,
    revision: review.submitted_at,
    user,
    ...(typeof review.html_url === "string" ? { url: review.html_url } : {}),
    threadNumber: prNumber,
    threadKind: "pull_request",
    ...(typeof review.commit_id === "string" ? { review: { commitId: review.commit_id } } : {}),
  }
}

/** The Bot resource of one command source. */
export function sourceResourceId(
  repository: string,
  threadNumber: number,
  kind: SourceKind,
  id: number | string
): string {
  return `${threadPrefix(repository, threadNumber)}${kind}:${id}`
}

/** Every command source of a thread starts with this. */
export function threadPrefix(repository: string, threadNumber: number): string {
  return `${repository.toLowerCase()}#${threadNumber}:`
}

export function commandEventId(source: CommandSourceV1): string {
  return `gh-cmd:${source.repositoryId}:${source.sourceKind}:${source.sourceId}:${source.sourceRevision}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The public, opaque name of a task: eight hex characters of its resource's
 * digest. It says nothing about the database, the account or the comment.
 */
export async function taskRef(resourceId: string): Promise<string> {
  return (await sha256Hex(`task:${resourceId}`)).slice(0, 8)
}

export const TASK_REF = /^[0-9a-f]{8}$/

export async function toCommandSource(
  raw: RawCommandComment & { threadKind: ThreadKind },
  repository: { id: string; fullName: string },
  ingress: CommandSourceV1["ingress"],
  parsed: Extract<ParsedCommand, { kind: "command" }>
): Promise<CommandSourceV1> {
  return {
    schemaVersion: 1,
    ingress,
    repositoryId: repository.id,
    repository: repository.fullName,
    threadKind: raw.threadKind,
    threadNumber: raw.threadNumber,
    sourceKind: raw.sourceKind,
    sourceId: String(raw.id),
    sourceRevision: raw.revision,
    sourceCreatedAt: raw.createdAt,
    sourceBodyHash: await sha256Hex(raw.body),
    ...(raw.url ? { sourceUrl: raw.url } : {}),
    actor: raw.user,
    verb: parsed.verb as CommandVerb,
    request: parsed.args,
    aliased: parsed.aliased,
    ...(raw.review ? { review: raw.review } : {}),
  }
}

/** Parse a comment against this installation's trigger. */
export function parseCommandComment(body: string, trigger: string): ParsedCommand {
  return parseCommand(body, commandGrammar(trigger))
}

/** A source record handed back by the Bot plane, checked before anything trusts it. */
export function parseCommandSource(value: unknown, repository: string): CommandSourceV1 {
  const source = value as CommandSourceV1 | null
  if (
    !source ||
    source.schemaVersion !== 1 ||
    source.repository?.toLowerCase() !== repository.toLowerCase() ||
    typeof source.repositoryId !== "string" ||
    !["issue", "pull_request"].includes(source.threadKind) ||
    !Number.isSafeInteger(source.threadNumber) ||
    source.threadNumber < 1 ||
    !["issue_comment", "review_comment", "review"].includes(source.sourceKind) ||
    !/^[1-9][0-9]*$/.test(source.sourceId) ||
    typeof source.sourceRevision !== "string" ||
    typeof source.sourceBodyHash !== "string" ||
    !source.actor ||
    typeof source.actor.id !== "number" ||
    typeof source.actor.login !== "string" ||
    !(COMMAND_VERBS as readonly string[]).includes(source.verb) ||
    typeof source.request !== "string"
  )
    throw new Error("Invalid or out-of-scope command source")
  return source
}

/** A command source without its command: what a control reply is addressed to. */
export type ReplyTarget = Omit<CommandSourceV1, "verb" | "request" | "aliased">

export function replyTargetOf(source: CommandSourceV1): ReplyTarget {
  const { verb: _verb, request: _request, aliased: _aliased, ...target } = source
  return target
}

export async function toReplyTarget(
  raw: RawCommandComment & { threadKind: ThreadKind },
  repository: { id: string; fullName: string },
  ingress: CommandSourceV1["ingress"]
): Promise<ReplyTarget> {
  return {
    schemaVersion: 1,
    ingress,
    repositoryId: repository.id,
    repository: repository.fullName,
    threadKind: raw.threadKind,
    threadNumber: raw.threadNumber,
    sourceKind: raw.sourceKind,
    sourceId: String(raw.id),
    sourceRevision: raw.revision,
    sourceCreatedAt: raw.createdAt,
    sourceBodyHash: await sha256Hex(raw.body),
    ...(raw.url ? { sourceUrl: raw.url } : {}),
    actor: raw.user,
    ...(raw.review ? { review: raw.review } : {}),
  }
}

export function parseReplyTarget(value: unknown, repository: string): ReplyTarget {
  return replyTargetOf(
    parseCommandSource(
      { ...(value as object), verb: "help", request: "", aliased: false },
      repository
    )
  )
}
