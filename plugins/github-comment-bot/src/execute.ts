/**
 * Answering one `ask` or `review` command, as a resumable Bot run.
 *
 * Step names are stable (plan §7.1): `collect-context`, `acquire-workspace`,
 * `dispatch-agent-1`, `capture-result`, `prepare-publication`, the
 * `answer:*` decision and write, and the tracking writes. The two
 * authorisation checks — at the start and again just before publishing —
 * are deliberately NOT steps: a replay must ask GitHub again, so an author
 * who lost access, or a comment that was edited or deleted, stops the work.
 */

import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { renderBotComment, renderOutputMarker, neutralizeMention } from "@cognia/github-bot-kit"

import { buildPrompt, parseAnswer, type AgentAnswer } from "./answer"
import {
  commandEventId,
  MARKER_NAMESPACE,
  parseCommandSource,
  sha256Hex,
  sourceResourceId,
  taskRef,
  type CommandSourceV1,
} from "./command-source"
import type { Config } from "./config"
import { collectContext, inDiff, readThreadItem, type CollectedContext } from "./context"
import { GITHUB_SLOT, readerFor, readIdentity, resolveTrigger } from "./identity"
import { expiredText, type BlockedReason } from "./messages"
import { authorizeAuthor, recheckSource } from "./recheck"
import { startTracking, updateTracking } from "./tracking"
import {
  decideWrite,
  executeWrite,
  isRunControlFlow,
  remoteUrl,
  replyAction,
  type ApprovedWrite,
} from "./write"

export type TaskStatus =
  "completed" | "blocked" | "failed" | "cancelled" | "superseded" | "expired" | "denied"

export interface TaskResultV1 {
  schemaVersion: 1
  status: TaskStatus
  taskRef: string
  reasonCode?: string
  answerUrl?: string
  /** The command this run answered: shown on the run's detail page. */
  source?: {
    repository: string
    thread: number
    kind: CommandSourceV1["sourceKind"]
    id: string
    url?: string
  }
  /** The exact commit the answer was produced against. */
  commitSha?: string
  /** What the context budget left out (items per kind) or cut. */
  context?: { omitted: Record<string, number>; truncatedItems: number; bytes: number }
  /** False when the context was cut, so a review is not a complete one. */
  complete?: boolean
  workspaceDirty?: boolean
  snapshotId?: string
}

/** Agent failures that are a verdict, not an outage: retrying sends the same content again. */
export function classifyAgentError(message: string): BlockedReason | undefined {
  if (/pii_blocked|PII redaction gate/i.test(message)) return "pii_blocked"
  if (/budget_exceeded|cost ceiling/i.test(message)) return "budget_exceeded"
  return undefined
}

type Dispatched =
  | { kind: "result"; result: Awaited<ReturnType<PluginContext["agent"]["runExternalAgent"]>> }
  | { kind: "blocked"; reason: BlockedReason; error: string }

export async function executeCommand(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  now: () => number = Date.now
) {
  const source = parseCommandSource(run.event.payload, config.repository)
  if (source.verb !== "ask" && source.verb !== "review")
    throw new Error("Only ask and review commands are answered by an agent")
  const reader = readerFor(ctx, run, config, now)
  const resourceId = sourceResourceId(
    source.repository,
    source.threadNumber,
    source.sourceKind,
    source.sourceId
  )
  const ref = await taskRef(resourceId)
  const rev = (await sha256Hex(source.sourceRevision)).slice(0, 8)
  const eventId = commandEventId(source)
  const identity = await readIdentity(reader)
  const trigger = resolveTrigger(config, identity)
  const t = ctx.i18n.t
  // Filled in as the run learns them, so every outcome carries what it knew.
  const facts: Partial<TaskResultV1> = {
    source: {
      repository: source.repository,
      thread: source.threadNumber,
      kind: source.sourceKind,
      id: source.sourceId,
      ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
    },
  }
  const finish = (status: TaskStatus, summary: string, extra: Partial<TaskResultV1> = {}) => ({
    summary,
    output: {
      schemaVersion: 1,
      status,
      taskRef: ref,
      ...facts,
      ...extra,
    } satisfies TaskResultV1,
  })
  const track = (phase: Parameters<typeof updateTracking>[3]["phase"], step: string) =>
    updateTracking(ctx, run, config, {
      resourceId,
      phase,
      step,
      idempotencyKey: `${eventId}:${step}`,
      trigger,
    })

  // ── authorize-execute: never memoised ──────────────────────────────────
  const opening = await recheckSource(reader, source, config, now)
  if (opening.status === "deleted")
    return finish("cancelled", "The command was deleted", { reasonCode: "source_deleted" })
  if (opening.status === "superseded")
    return finish("superseded", "The command was edited; the new version is handled separately")
  const author = await authorizeAuthor(reader, source.actor, config)
  if (author.outcome === "denied") {
    // Local audit only: a refusal is never announced on GitHub.
    run.log("warn", "Command author is not authorized", { reason: author.reason, taskRef: ref })
    return finish("denied", "The command author is not authorized", { reasonCode: author.reason })
  }
  if (opening.status === "expired") {
    if (config.publicationMode === "automatic") {
      const markerId = `x-${ref}-${rev}`
      const marker = renderOutputMarker(MARKER_NAMESPACE, markerId)
      const body = renderBotComment(expiredText(t, config.commandMaxAgeMs / 3_600_000), {
        namespace: MARKER_NAMESPACE,
        id: markerId,
        mention: trigger,
      })
      const write: ApprovedWrite = {
        step: "expired",
        ...replyAction(source, body, marker),
        idempotencyKey: `${eventId}:expired`,
        title: t("approval.reply.title"),
        message: t("approval.reply.message"),
        detail: { taskRef: ref, reply: "expired" },
        reconcile: true,
      }
      const decision = await decideWrite(run, config, write, now)
      if (decision.outcome === "approved") await executeWrite(ctx, run, write, decision)
    }
    return finish("expired", "The command is older than the installation accepts")
  }

  await startTracking(ctx, run, config, { source, resourceId, eventId, ref, rev, trigger })

  try {
    return await answer()
  } catch (error) {
    if (!isRunControlFlow(error, run.signal)) await track({ kind: "failed" }, "tracking-failed")
    throw error
  }

  async function blocked(
    reason: BlockedReason,
    summary: string,
    extra: Partial<TaskResultV1> = {}
  ) {
    await track({ kind: "blocked", reason }, `tracking-blocked-${reason}`)
    return finish("blocked", summary, { reasonCode: reason, ...extra })
  }

  async function answer() {
    const collected: CollectedContext = await run.step.run("collect-context", () =>
      collectContext(reader, source, now)
    )
    facts.context = {
      omitted: collected.selection.omitted,
      truncatedItems: collected.selection.truncatedItems,
      bytes: collected.selection.bytes,
    }
    if (!collected.checkout.sha)
      return blocked("context_unavailable", "The pull request head could not be read")
    facts.commitSha = collected.checkout.sha
    const workspace = await run.step.run("acquire-workspace", () =>
      ctx.workspace.acquire({
        kind: "bot-run",
        runId: run.runId,
        repository: config.repository,
        ref: collected.checkout.ref,
        ...(collected.checkout.targetRef ? { targetRef: collected.checkout.targetRef } : {}),
        credentialSlot: GITHUB_SLOT,
      })
    )
    // A pull ref moves with every push; the checkout must be the head that was read.
    if (workspace.headRef?.toLowerCase() !== collected.checkout.sha.toLowerCase())
      return blocked("target_changed", "The pull request moved while it was being checked out")

    run.progress({ message: `Answering ${source.verb} ${ref}` })
    const prompt = buildPrompt(source, collected.item, collected.selection, collected.complete)
    const dispatched: Dispatched = await run.step.run("dispatch-agent-1", async () => {
      try {
        return {
          kind: "result" as const,
          result: await ctx.agent.runExternalAgent(config.agentPreset, prompt, {
            runId: run.runId,
            workspace,
            permissionMode: "acceptEdits",
            timeoutMs: config.timeoutMs,
            signal: run.signal,
            invocationId: "attempt-1",
            ...(config.model ? { model: config.model } : {}),
          }),
        }
      } catch (error) {
        if (isRunControlFlow(error, run.signal)) throw error
        const message = error instanceof Error ? error.message : String(error)
        const reason = classifyAgentError(message)
        if (!reason) throw error
        return { kind: "blocked" as const, reason, error: message }
      }
    })
    if (dispatched.kind === "blocked")
      return blocked(dispatched.reason, `Answer blocked: ${dispatched.reason}`)
    const result = dispatched.result
    if (result.status === "recovery_required")
      return blocked(
        "recovery_required",
        "The agent session needs inspection; the prompt is not sent again"
      )
    if (result.status !== "completed") {
      const reason = classifyAgentError(result.error ?? "")
      if (reason) return blocked(reason, `Answer blocked: ${reason}`)
      await track({ kind: "failed" }, "tracking-failed")
      return finish("failed", `The agent ${result.status}`, { reasonCode: "agent_failed" })
    }

    // ── check-workspace: the agent was told the checkout is read-only ──────
    const snapshot = await run.step.run("capture-result", () => ctx.workspace.snapshot(workspace))
    if (snapshot.files.length > 0 || snapshot.diff.trim())
      return blocked(
        "readonly_violation",
        "The agent modified the checkout; nothing is published",
        {
          workspaceDirty: true,
          snapshotId: snapshot.id,
        }
      )

    let parsed: AgentAnswer
    try {
      parsed = parseAnswer(result.text ?? "", source.verb)
    } catch (error) {
      run.log("warn", "Agent answer rejected", {
        error: error instanceof Error ? error.message : String(error),
      })
      return blocked("invalid_result", "The agent's answer could not be used")
    }

    const write: ApprovedWrite = await run.step.run("prepare-publication", () =>
      preparePublication(ctx, config, { source, collected, parsed, ref, rev, eventId, trigger })
    )
    await track({ kind: "waiting" }, "tracking-waiting")
    const decision = await decideWrite(run, config, write, now)
    if (decision.outcome !== "approved") {
      await track({ kind: "cancelled" }, "tracking-not-approved")
      return finish("cancelled", `Publication ${decision.outcome}`, {
        reasonCode: `approval_${decision.outcome}`,
      })
    }

    // ── authorize-publish: never memoised ──────────────────────────────────
    const closing = await recheckSource(reader, source, config, now, { checkAge: false })
    if (closing.status === "deleted") {
      await track({ kind: "cancelled" }, "tracking-deleted")
      return finish("cancelled", "The command was deleted before publication", {
        reasonCode: "source_deleted",
      })
    }
    if (closing.status === "superseded") {
      await track({ kind: "cancelled" }, "tracking-superseded")
      return finish("superseded", "The command was edited before publication")
    }
    const stillAllowed = await authorizeAuthor(reader, source.actor, config)
    if (stillAllowed.outcome === "denied") {
      run.log("warn", "Command author lost access before publication", {
        reason: stillAllowed.reason,
        taskRef: ref,
      })
      await track({ kind: "cancelled" }, "tracking-denied")
      return finish("denied", "The command author is no longer authorized", {
        reasonCode: stillAllowed.reason,
      })
    }
    if (source.verb === "review") {
      const current = await readThreadItem(reader, source)
      if (current.headSha !== collected.item.headSha)
        return blocked("target_changed", "The pull request changed after it was reviewed")
    }

    const receipt = await executeWrite(ctx, run, write, decision)
    const answerUrl = remoteUrl(receipt.remote)
    await track(
      { kind: "completed", ...(answerUrl ? { url: answerUrl } : {}) },
      "tracking-completed"
    )
    return finish("completed", source.verb === "review" ? "Review published" : "Answer published", {
      ...(answerUrl ? { answerUrl } : {}),
      complete: collected.complete,
    })
  }
}

export function preparePublication(
  ctx: PluginContext,
  config: Config,
  input: {
    source: CommandSourceV1
    collected: CollectedContext
    parsed: AgentAnswer
    ref: string
    rev: string
    eventId: string
    trigger: string
  }
): ApprovedWrite {
  const t = ctx.i18n.t
  const { source, collected, parsed, ref, rev, eventId, trigger } = input
  const markerId = `a-${ref}-${rev}`
  const marker = renderOutputMarker(MARKER_NAMESPACE, markerId)
  const notes = [
    ...(collected.complete ? [] : [t("answer.incomplete")]),
    ...(source.aliased ? [t("answer.aliased", { trigger })] : []),
  ]
  const common = {
    step: "answer",
    idempotencyKey: `${eventId}:answer`,
    title: t(source.verb === "review" ? "approval.review.title" : "approval.answer.title"),
    message: t("approval.answer.message"),
    detail: {
      taskRef: ref,
      command: source.verb,
      thread: source.threadNumber,
      complete: collected.complete,
      context: {
        items: collected.selection.items.map(({ id, kind, source: from, bytes, truncated }) => ({
          id,
          kind,
          source: from,
          bytes,
          truncated,
        })),
        omitted: collected.selection.omitted,
        fetchedBytes: collected.fetchedBytes,
      },
    },
  }
  if (parsed.kind === "ask") {
    const body = renderBotComment([parsed.answer, ...notes].join("\n\n"), {
      namespace: MARKER_NAMESPACE,
      id: markerId,
      mention: trigger,
    })
    return { ...common, ...replyAction(source, body, marker), reconcile: true }
  }
  const inline = parsed.findings.filter((finding) =>
    inDiff(collected.diffIndex, finding.path, finding.line, finding.side)
  )
  const outside = parsed.findings.filter((finding) => !inline.includes(finding))
  const text = [
    parsed.summary,
    ...(outside.length
      ? [
          t("answer.findingsOutsideDiff"),
          outside
            .map((finding) => `- \`${finding.path}:${finding.line}\` ${finding.body}`)
            .join("\n"),
        ]
      : []),
    ...notes,
  ].join("\n\n")
  return {
    ...common,
    actionId: "reviewPr",
    input: {
      repoFullName: source.repository,
      prNumber: source.threadNumber,
      body: renderBotComment(text, { namespace: MARKER_NAMESPACE, id: markerId, mention: trigger }),
      // Only ever a comment review: the Bot neither approves nor requests changes.
      event: "COMMENT",
      commitId: collected.item.headSha,
      ...(inline.length
        ? {
            comments: inline.map((finding) => ({
              ...finding,
              body: neutralizeMention(finding.body, trigger),
            })),
          }
        : {}),
    },
  }
}
