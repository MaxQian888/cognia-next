/**
 * Control replies (help, status, cancel, usage, not-enabled, expired) and
 * tracking cancellations, each its own short run so receiving never waits on
 * a person. Every reply is a fixed template and is published like an answer:
 * re-check the command and its author, then the approved write.
 */

import type { BotDeliverySummary, BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { renderBotComment, renderOutputMarker } from "@cognia/github-bot-kit"

import {
  MARKER_NAMESPACE,
  parseReplyTarget,
  sha256Hex,
  taskRef,
  threadPrefix,
} from "./command-source"
import type { Config } from "./config"
import type { TaskResultV1 } from "./execute"
import { readerFor, readIdentity, resolveTrigger } from "./identity"
import {
  cancelledText,
  expiredText,
  helpText,
  notEnabledText,
  statusText,
  usageText,
  type ReplyRequest,
  type StatusLine,
  type TaskState,
} from "./messages"
import type { ReplyEnvelopeV1, TrackingCancelEnvelopeV1 } from "./receive"
import { authorizeAuthor, recheckSource } from "./recheck"
import { updateTracking } from "./tracking"
import { decideWrite, executeWrite, remoteUrl, replyAction, type ApprovedWrite } from "./write"

const STATUS_LINES = 10

function stateOf(row: BotDeliverySummary, result?: TaskResultV1): TaskState {
  switch (row.status) {
    case "pending":
    case "leased":
      return "queued"
    case "running":
      return "running"
    case "parked":
      return "waiting"
    case "succeeded":
      if (!result || result.status === "completed") return "completed"
      return result.status === "blocked" || result.status === "failed" ? "failed" : "cancelled"
    case "failed":
    case "deadletter":
      return "failed"
    case "dismissed":
      return "cancelled"
  }
}

export async function threadStatus(
  ctx: PluginContext,
  run: BotRunContextV1,
  repository: string,
  threadNumber: number,
  ref?: string
): Promise<StatusLine[]> {
  const prefix = threadPrefix(repository, threadNumber)
  const rows = (
    await ctx.bots.listDeliveries(run.runId, { triggerId: "execute", limit: 200 })
  ).filter((row) => row.resource?.id.startsWith(prefix))
  const lines: StatusLine[] = []
  for (const row of rows) {
    const rowRef = await taskRef(row.resource!.id)
    if (ref && rowRef !== ref) continue
    // One line per task: the newest version of a command is its status.
    if (lines.some((line) => line.ref === rowRef)) continue
    const result =
      row.status === "succeeded" && row.runId
        ? ((await ctx.bots.getRunResult(run.runId, { runId: row.runId }))?.output as
            TaskResultV1 | undefined)
        : undefined
    const state = stateOf(row, result)
    lines.push({
      ref: rowRef,
      state,
      ...(state === "completed" && result?.answerUrl ? { url: result.answerUrl } : {}),
    })
    if (lines.length >= STATUS_LINES) break
  }
  return lines
}

export async function replyToCommand(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  now: () => number = Date.now
) {
  const payload = run.event.payload as ReplyEnvelopeV1 | TrackingCancelEnvelopeV1
  const reader = readerFor(ctx, run, config, now)
  const identity = await readIdentity(reader)
  const trigger = resolveTrigger(config, identity)

  if ("resourceIds" in payload) {
    if (
      payload.schemaVersion !== 1 ||
      payload.repository?.toLowerCase() !== config.repository.toLowerCase() ||
      !Array.isArray(payload.resourceIds)
    )
      throw new Error("Invalid tracking cancellation")
    for (const [index, resourceId] of payload.resourceIds.entries()) {
      if (
        typeof resourceId !== "string" ||
        !resourceId.startsWith(`${config.repository.toLowerCase()}#`)
      )
        continue
      await updateTracking(ctx, run, config, {
        resourceId,
        phase: { kind: "cancelled" },
        step: `tracking-cancel-${index}`,
        idempotencyKey: `${run.event.eventId}:tracking-cancel-${index}`,
        trigger,
      })
    }
    return { summary: "Tracking comments updated", output: { status: "completed" } }
  }

  if (payload?.schemaVersion !== 1) throw new Error("Invalid control reply")
  const target = parseReplyTarget(payload.target, config.repository)
  const reply = payload.reply as ReplyRequest
  // Publishing re-checks like an answer does: a deleted or edited command,
  // or an author who lost access, gets no reply.
  const check = await recheckSource(reader, target, config, now, { checkAge: false })
  if (check.status !== "current")
    return {
      summary: `No reply: the command was ${check.status}`,
      output: { status: check.status },
    }
  const author = await authorizeAuthor(reader, target.actor, config)
  if (author.outcome === "denied")
    return { summary: "No reply: the author is not authorized", output: { status: "denied" } }

  const t = ctx.i18n.t
  let text: string
  switch (reply.kind) {
    case "help":
      text = helpText(t, trigger)
      break
    case "usage":
      text = usageText(t, reply.reason, trigger, reply.verb)
      break
    case "not_enabled":
      text = notEnabledText(t, reply.verb)
      break
    case "expired":
      text = expiredText(t, config.commandMaxAgeMs / 3_600_000)
      break
    case "cancelled":
      text = cancelledText(t, reply.taskRefs)
      break
    case "status":
      text = statusText(
        t,
        await threadStatus(ctx, run, config.repository, target.threadNumber, reply.taskRef)
      )
      break
    default:
      throw new Error("Unknown control reply")
  }
  const rev = (await sha256Hex(target.sourceRevision)).slice(0, 8)
  const markerId = `r-${target.sourceId}-${rev}-${reply.kind.replace(/_/g, "-")}`
  const marker = renderOutputMarker(MARKER_NAMESPACE, markerId)
  const body = renderBotComment(text, {
    namespace: MARKER_NAMESPACE,
    id: markerId,
    mention: trigger,
  })
  const write: ApprovedWrite = {
    step: "reply",
    ...replyAction(target, body, marker),
    idempotencyKey: `${run.event.eventId}:reply`,
    title: t("approval.reply.title"),
    message: t("approval.reply.message"),
    detail: { reply: reply.kind, thread: target.threadNumber },
    reconcile: true,
  }
  const decision = await decideWrite(run, config, write, now)
  if (decision.outcome !== "approved")
    return { summary: `Reply ${decision.outcome}`, output: { status: decision.outcome } }
  const receipt = await executeWrite(ctx, run, write, decision)
  const url = remoteUrl(receipt.remote)
  return { summary: "Reply published", output: { status: "completed", ...(url ? { url } : {}) } }
}
