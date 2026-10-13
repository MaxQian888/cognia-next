/**
 * The one tracking comment per answered command (automatic publication only).
 *
 * It states the task's opaque reference and phase from a fixed template and
 * nothing else. Its id is kept with the installation so a later phase, or a
 * cancellation handled by another run, edits the same comment; the Delivery
 * action refuses to edit any comment that does not carry its marker. Phases
 * only move forward: once final, an older run's update is dropped.
 *
 * `failed` is not final. A run that throws is retried by the host, and the
 * plugin cannot tell its last attempt from an earlier one, so the comment
 * says "failed" until a retry resumes it ("working on it") or finishes it.
 * Each failure is its own step, so a second failure after a resume is written
 * again instead of being replayed from the first one's memo.
 */

import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { renderBotComment, renderOutputMarker } from "@cognia/github-bot-kit"

import { MARKER_NAMESPACE, type CommandSourceV1 } from "./command-source"
import type { Config } from "./config"
import { trackingText } from "./messages"
import { conversationAction, decideWrite, executeWrite, isRunControlFlow, remoteId } from "./write"

export type TrackingPhase = Parameters<typeof trackingText>[2]

export interface TrackingRecord {
  commentId: number
  marker: string
  markerId: string
  ref: string
  repository: string
  phase: TrackingPhase["kind"]
  /** How many times a run has marked it failed; names each failure's step. */
  failures?: number
}

const FINAL = new Set<TrackingPhase["kind"]>(["completed", "blocked", "cancelled"])

export const trackingKey = (installationId: string, resourceId: string) =>
  `tracking:v1:${installationId}:${resourceId}`

export async function startTracking(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  input: {
    source: CommandSourceV1
    resourceId: string
    eventId: string
    ref: string
    rev: string
    trigger: string
  }
): Promise<TrackingRecord | undefined> {
  if (config.publicationMode !== "automatic") return undefined
  const key = trackingKey(run.installationId, input.resourceId)
  const markerId = `t-${input.ref}-${input.rev}`
  const existing = await ctx.storage.get<TrackingRecord>(key)
  if (existing?.markerId === markerId) {
    // A retry of a run that failed: say it is working again.
    if (existing.phase === "failed") {
      const n = existing.failures ?? 1
      await updateTracking(ctx, run, config, {
        resourceId: input.resourceId,
        phase: { kind: "running" },
        step: `tracking-resumed-${n}`,
        idempotencyKey: `${input.eventId}:tracking-resumed-${n}`,
        trigger: input.trigger,
      })
    }
    return existing
  }
  const marker = renderOutputMarker(MARKER_NAMESPACE, markerId)
  const body = renderBotComment(trackingText(ctx.i18n.t, input.ref, { kind: "running" }), {
    namespace: MARKER_NAMESPACE,
    id: markerId,
    mention: input.trigger,
  })
  const write = {
    step: "tracking-create",
    ...conversationAction(input.source, body, marker),
    idempotencyKey: `${input.eventId}:tracking-create`,
    title: ctx.i18n.t("approval.tracking.title"),
    message: ctx.i18n.t("approval.tracking.message"),
    detail: { taskRef: input.ref },
    reconcile: true,
  }
  const decision = await decideWrite(run, config, write)
  if (decision.outcome !== "approved") return undefined
  const receipt = await executeWrite(ctx, run, write, decision)
  const commentId = remoteId(receipt.remote)
  if (!commentId) {
    run.log(
      "warn",
      "Tracking comment was written but GitHub returned no id; it will not be updated"
    )
    return undefined
  }
  const record: TrackingRecord = {
    commentId,
    marker,
    markerId,
    ref: input.ref,
    repository: config.repository,
    phase: "running",
  }
  await ctx.storage.set(key, record)
  return record
}

/**
 * Move the tracking comment to `phase`. Best effort: the answer itself is
 * what matters, so a failed tracking edit is logged, never fatal.
 */
export async function updateTracking(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  input: {
    resourceId: string
    phase: TrackingPhase
    step: string
    idempotencyKey: string
    trigger: string
  }
): Promise<void> {
  const key = trackingKey(run.installationId, input.resourceId)
  const record = await ctx.storage.get<TrackingRecord>(key)
  if (!record || FINAL.has(record.phase) || record.repository !== config.repository) return
  const failure = input.phase.kind === "failed" ? (record.failures ?? 0) + 1 : undefined
  const step = failure ? `${input.step}-${failure}` : input.step
  const idempotencyKey = failure ? `${input.idempotencyKey}-${failure}` : input.idempotencyKey
  try {
    const body = renderBotComment(trackingText(ctx.i18n.t, record.ref, input.phase), {
      namespace: MARKER_NAMESPACE,
      id: record.markerId,
      mention: input.trigger,
    })
    const write = {
      step,
      actionId: "updateComment" as const,
      input: {
        repoFullName: config.repository,
        commentId: record.commentId,
        kind: "issue",
        body,
        marker: record.marker,
      },
      idempotencyKey,
      title: ctx.i18n.t("approval.tracking.title"),
      message: ctx.i18n.t("approval.tracking.message"),
      detail: { taskRef: record.ref, phase: input.phase.kind },
    }
    const decision = await decideWrite(run, config, write)
    if (decision.outcome !== "approved") return
    await executeWrite(ctx, run, write, decision)
    const latest = await ctx.storage.get<TrackingRecord>(key)
    if (latest && !FINAL.has(latest.phase))
      await ctx.storage.set(key, {
        ...latest,
        phase: input.phase.kind,
        ...(failure ? { failures: failure } : {}),
      })
  } catch (error) {
    if (isRunControlFlow(error, run.signal)) throw error
    run.log("warn", "Tracking comment update failed", {
      phase: input.phase.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
