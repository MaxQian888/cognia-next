/**
 * The short half: notice a command, decide whether it is one, and queue the
 * work. It never waits on a person and never runs a model, so a burst of
 * comments cannot hold a slot.
 *
 * In order, a candidate is dropped when it is: this Bot's own output (its
 * marker, or its own account), a machine account's, already handled at this
 * version, edited by someone other than its author, not addressed to the
 * Bot, from before the installation was activated, older than the
 * installation's validity window, or from an author who is not allowed.
 * A refusal is audited locally and never answered in public.
 */

import type { BotEventEnvelopeV1, BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import {
  findOutputMarker,
  isBotUser,
  type GithubReader,
  type ParsedCommand,
} from "@cognia/github-bot-kit"

import {
  commandEventId,
  fromIssueComment,
  fromReview,
  fromReviewComment,
  MARKER_NAMESPACE,
  parseCommandComment,
  sha256Hex,
  sourceResourceId,
  TASK_REF,
  taskRef,
  threadPrefix,
  toCommandSource,
  toReplyTarget,
  type CommandSourceV1,
  type GithubActor,
  type IssueCommentPayload,
  type RawCommandComment,
  type ReplyTarget,
  type ReviewCommentPayload,
  type ReviewPayload,
  type ThreadKind,
} from "./command-source"
import type { Config } from "./config"
import type { BotIdentity } from "./identity"
import type { ReplyRequest } from "./messages"
import { authorizeAuthor } from "./recheck"

export interface Candidate {
  action: "upsert" | "delete"
  raw: RawCommandComment
  ingress: CommandSourceV1["ingress"]
  repository: { id: string; fullName: string }
  /** Who performed the event (webhook only); an edit by anyone else is not the author's. */
  sender?: GithubActor
}

export type CandidateOutcome = "queued" | "replied" | "cancelled" | "ignored" | "denied" | "expired"

/** Event types the `github` trigger listens to. */
export const COMMAND_EVENT_TYPES = [
  "issue_comment.created",
  "issue_comment.edited",
  "issue_comment.deleted",
  "pull_request_review_comment.created",
  "pull_request_review_comment.edited",
  "pull_request_review_comment.deleted",
  "pull_request_review.submitted",
] as const

interface WebhookPayload {
  repository?: { id?: unknown; full_name?: unknown }
  sender?: { id?: unknown; login?: unknown; type?: unknown }
  comment?: IssueCommentPayload & ReviewCommentPayload
  issue?: { number?: unknown; pull_request?: unknown }
  pull_request?: { number?: unknown }
  review?: ReviewPayload
}

export function candidateFromEvent(
  event: Pick<BotEventEnvelopeV1, "type" | "payload">,
  config: Pick<Config, "repository">
): Candidate | undefined {
  const payload = (event.payload ?? {}) as WebhookPayload
  const fullName = payload.repository?.full_name
  const id = payload.repository?.id
  if (
    typeof fullName !== "string" ||
    fullName.toLowerCase() !== config.repository.toLowerCase() ||
    (typeof id !== "number" && typeof id !== "string")
  )
    return undefined
  const repository = { id: String(id), fullName }
  const sender =
    typeof payload.sender?.id === "number" && typeof payload.sender.login === "string"
      ? {
          id: payload.sender.id,
          login: payload.sender.login,
          ...(typeof payload.sender.type === "string" ? { type: payload.sender.type } : {}),
        }
      : undefined
  const [kind, action] = event.type.split(".")
  let raw: RawCommandComment | undefined
  if (kind === "issue_comment" && payload.comment)
    raw = fromIssueComment(payload.comment, payload.issue)
  else if (kind === "pull_request_review_comment" && payload.comment)
    raw = fromReviewComment(
      payload.comment,
      typeof payload.pull_request?.number === "number" ? payload.pull_request.number : undefined
    )
  else if (
    kind === "pull_request_review" &&
    payload.review &&
    typeof payload.pull_request?.number === "number"
  )
    raw = fromReview(payload.review, payload.pull_request.number)
  if (!raw) return undefined
  return {
    action: action === "deleted" ? "delete" : "upsert",
    raw,
    ingress: "webhook",
    repository,
    ...(sender ? { sender } : {}),
  }
}

export interface ReceiveEnvironment {
  reader: GithubReader
  identity: BotIdentity
  trigger: string
  /** Comments created before this are history, never commands. */
  watermark: number
  now: () => number
}

const seenKey = (installationId: string, resourceId: string) =>
  `seen:v1:${installationId}:${resourceId}`

export async function considerCandidate(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  env: ReceiveEnvironment,
  candidate: Candidate
): Promise<CandidateOutcome> {
  const { raw } = candidate
  const resourceId = sourceResourceId(
    candidate.repository.fullName,
    raw.threadNumber,
    raw.sourceKind,
    raw.id
  )
  if (candidate.action === "delete") {
    const cancelled = await ctx.bots.cancelResource(run.runId, { resourceId })
    if (cancelled) await enqueueTrackingCancel(ctx, run, config, candidate, [resourceId])
    return cancelled ? "cancelled" : "ignored"
  }
  if (findOutputMarker(raw.body, MARKER_NAMESPACE)) return "ignored"
  if (raw.user.id === env.identity.id || isBotUser(raw.user)) return "ignored"
  const seen = seenKey(run.installationId, resourceId)
  if ((await ctx.storage.get<string>(seen)) === raw.revision) return "ignored"
  const markSeen = () => ctx.storage.set(seen, raw.revision)

  // Someone else's edit cannot command the Bot with the author's authority,
  // and the author's earlier version no longer exists on GitHub.
  if (candidate.sender && candidate.sender.id !== raw.user.id) {
    await supersede(ctx, run, config, candidate, resourceId)
    await markSeen()
    return "cancelled"
  }
  const parsed: ParsedCommand = parseCommandComment(raw.body, env.trigger)
  if (parsed.kind === "none") {
    // An edit that removed the mention withdraws the command.
    await supersede(ctx, run, config, candidate, resourceId)
    await markSeen()
    return "ignored"
  }
  if (Date.parse(raw.createdAt) < env.watermark) {
    await markSeen()
    return "ignored"
  }
  const threadKind: ThreadKind =
    raw.threadKind ??
    ((await env.reader.request<{ pull_request?: unknown }>(`/issues/${raw.threadNumber}`)).data
      .pull_request
      ? "pull_request"
      : "issue")
  const located = { ...raw, threadKind }
  const target = await toReplyTarget(located, candidate.repository, candidate.ingress)

  if (env.now() - Date.parse(raw.revision) > config.commandMaxAgeMs) {
    // Automatic mode answers with a fixed template; approval mode would ask
    // a person to approve telling someone their command was too old.
    if (config.publicationMode === "automatic") {
      const author = await authorizeAuthor(env.reader, raw.user, config)
      if (author.outcome === "allowed") await enqueueReply(ctx, run, target, { kind: "expired" })
    }
    await markSeen()
    return "expired"
  }
  const author = await authorizeAuthor(env.reader, raw.user, config)
  if (author.outcome === "denied") {
    run.log("warn", "Command from an unauthorized author ignored", {
      reason: author.reason,
      thread: raw.threadNumber,
    })
    await markSeen()
    return "denied"
  }

  const outcome = await dispatch(ctx, run, config, candidate, located, target, parsed, resourceId)
  await markSeen()
  return outcome
}

async function dispatch(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  candidate: Candidate,
  raw: RawCommandComment & { threadKind: ThreadKind },
  target: ReplyTarget,
  parsed: Exclude<ParsedCommand, { kind: "none" }>,
  resourceId: string
): Promise<CandidateOutcome> {
  // A newer version of this comment replaces whatever its older one queued.
  await ctx.bots.cancelResource(run.runId, { resourceId, exceptRevision: raw.revision })
  if (parsed.kind === "invalid") {
    await enqueueReply(ctx, run, target, {
      kind: "usage",
      reason: parsed.reason,
      ...(parsed.verb ? { verb: parsed.verb } : {}),
    })
    return "replied"
  }
  const refArgument = (args: string) => {
    const value = args.trim().replace(/^#/, "").toLowerCase()
    return value === "" ? null : TASK_REF.test(value) ? value : undefined
  }
  switch (parsed.verb) {
    case "help":
      await enqueueReply(ctx, run, target, { kind: "help" })
      return "replied"
    case "fix":
    case "retry":
      await enqueueReply(ctx, run, target, { kind: "not_enabled", verb: parsed.verb })
      return "replied"
    case "status": {
      const value = refArgument(parsed.args)
      if (value === undefined) {
        await enqueueReply(ctx, run, target, { kind: "usage", reason: "bad_task_ref" })
        return "replied"
      }
      await enqueueReply(ctx, run, target, { kind: "status", ...(value ? { taskRef: value } : {}) })
      return "replied"
    }
    case "cancel": {
      const value = refArgument(parsed.args)
      if (value === undefined) {
        await enqueueReply(ctx, run, target, { kind: "usage", reason: "bad_task_ref" })
        return "replied"
      }
      const cancelled = await cancelThreadTasks(ctx, run, candidate, raw.threadNumber, value)
      if (cancelled.resourceIds.length)
        await enqueueTrackingCancel(ctx, run, config, candidate, cancelled.resourceIds)
      await enqueueReply(ctx, run, target, { kind: "cancelled", taskRefs: cancelled.refs })
      return "cancelled"
    }
    case "review":
      if (raw.threadKind !== "pull_request") {
        await enqueueReply(ctx, run, target, { kind: "usage", reason: "review_on_issue" })
        return "replied"
      }
      break
    case "ask":
      break
  }
  const source = await toCommandSource(raw, candidate.repository, candidate.ingress, parsed)
  await ctx.bots.enqueue(run.runId, {
    triggerId: "execute",
    eventId: commandEventId(source),
    type: "github-command.execute",
    payload: { ...source, revision: source.sourceRevision },
    resource: {
      kind: "github_command",
      id: resourceId,
      scope: source.repositoryId,
      ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
    },
  })
  return "queued"
}

/** The thread's unfinished answers, newest first; `ref` narrows to one. */
export async function activeThreadTasks(
  ctx: PluginContext,
  run: BotRunContextV1,
  repository: string,
  threadNumber: number
) {
  const prefix = threadPrefix(repository, threadNumber)
  const rows = await ctx.bots.listDeliveries(run.runId, {
    triggerId: "execute",
    status: ["pending", "leased", "running", "parked"],
    limit: 200,
  })
  return Promise.all(
    rows
      .filter((row) => row.resource?.id.startsWith(prefix))
      .map(async (row) => ({ row, ref: await taskRef(row.resource!.id) }))
  )
}

async function cancelThreadTasks(
  ctx: PluginContext,
  run: BotRunContextV1,
  candidate: Candidate,
  threadNumber: number,
  ref: string | null
): Promise<{ refs: string[]; resourceIds: string[] }> {
  const active = await activeThreadTasks(ctx, run, candidate.repository.fullName, threadNumber)
  const targets = ref ? active.filter((task) => task.ref === ref) : active.slice(0, 1)
  const resourceIds = [...new Set(targets.map((task) => task.row.resource!.id))]
  for (const resourceId of resourceIds) await ctx.bots.cancelResource(run.runId, { resourceId })
  return {
    refs: [...new Set(targets.map((task) => task.ref))],
    resourceIds,
  }
}

async function supersede(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  candidate: Candidate,
  resourceId: string
) {
  const cancelled = await ctx.bots.cancelResource(run.runId, { resourceId })
  if (cancelled) await enqueueTrackingCancel(ctx, run, config, candidate, [resourceId])
}

export interface ReplyEnvelopeV1 {
  schemaVersion: 1
  /** For `cancelResource(..., exceptRevision)`: a newer version supersedes this reply too. */
  revision: string
  target: ReplyTarget
  reply: ReplyRequest
}

export interface TrackingCancelEnvelopeV1 {
  schemaVersion: 1
  revision: string
  repository: string
  repositoryId: string
  resourceIds: string[]
}

async function enqueueReply(
  ctx: PluginContext,
  run: BotRunContextV1,
  target: ReplyTarget,
  reply: ReplyRequest
) {
  const resourceId = sourceResourceId(
    target.repository,
    target.threadNumber,
    target.sourceKind,
    target.sourceId
  )
  await ctx.bots.enqueue(run.runId, {
    triggerId: "reply",
    eventId: `gh-cmd-reply:${target.repositoryId}:${target.sourceKind}:${target.sourceId}:${target.sourceRevision}:${reply.kind}`,
    type: "github-command.reply",
    payload: {
      schemaVersion: 1,
      revision: target.sourceRevision,
      target,
      reply,
    } satisfies ReplyEnvelopeV1,
    resource: { kind: "github_command", id: resourceId, scope: target.repositoryId },
  })
}

/** Cancelled work's tracking comments say so; only automatic mode has any. */
async function enqueueTrackingCancel(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  candidate: Candidate,
  resourceIds: string[]
) {
  if (config.publicationMode !== "automatic" || !resourceIds.length) return
  const digest = (await sha256Hex(JSON.stringify([...resourceIds].sort()))).slice(0, 16)
  await ctx.bots.enqueue(run.runId, {
    triggerId: "reply",
    eventId: `gh-cmd-track:${candidate.repository.id}:${digest}:${candidate.raw.revision}`,
    type: "github-command.tracking",
    payload: {
      schemaVersion: 1,
      revision: candidate.raw.revision,
      repository: candidate.repository.fullName,
      repositoryId: candidate.repository.id,
      resourceIds,
    } satisfies TrackingCancelEnvelopeV1,
    resource: {
      kind: "github_command_tracking",
      id: `tracking:${digest}`,
      scope: candidate.repository.id,
    },
  })
}
