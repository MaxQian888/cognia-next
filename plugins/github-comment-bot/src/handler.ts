/**
 * One handler, routed by trigger: `github` (webhook) and `poll` receive,
 * `execute` answers, `reply` posts control replies. A configuration the Bot
 * cannot run with ends the run as `needs_setup` with a stable code in the
 * installation's monitor, rather than failing and retrying forever.
 */

import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { GithubRequestError } from "@cognia/github-bot-kit"

import { parseConfig, SetupError, type Config } from "./config"
import { executeCommand } from "./execute"
import { readerFor, readIdentity, resolveTrigger } from "./identity"
import { initialCursor, pollCandidates, WEBHOOK_SAFETY_NET_MS, type PollCursor } from "./poll"
import { candidateFromEvent, considerCandidate, type CandidateOutcome } from "./receive"
import { AuthorCheckUnavailableError } from "./recheck"
import { replyToCommand } from "./reply"

const pollKey = (installationId: string, repository: string) =>
  `poll:v1:${installationId}:${repository.toLowerCase()}`

export async function receiveCommands(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  now: () => number = Date.now
) {
  const installation = await ctx.bots.getInstallation(run.runId)
  const reader = readerFor(ctx, run, config, now)
  const identity = await readIdentity(reader)
  const trigger = resolveTrigger(config, identity)
  const watermark = installation.activatedAt ?? installation.createdAt
  const env = { reader, identity, trigger, watermark, now }
  const counts: Partial<Record<CandidateOutcome, number>> = {}
  const tally = (outcome: CandidateOutcome) => {
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }

  if (run.event.source === "integration") {
    const candidate = candidateFromEvent(run.event, config)
    if (candidate) tally(await considerCandidate(ctx, run, config, env, candidate))
    return {
      summary: candidate ? "Comment event handled" : "Not a command event for this repository",
      output: { ingress: "webhook", counts },
    }
  }

  // ── poll ──────────────────────────────────────────────────────────────
  const key = pollKey(run.installationId, config.repository)
  const stored = await ctx.storage.get<PollCursor>(key)
  const cursor: PollCursor = stored?.version === 1 ? stored : initialCursor(watermark)
  const manual = run.event.source === "manual"
  if (!manual && cursor.retryAt && cursor.retryAt > now())
    return { summary: "GitHub rate-limit backoff", output: { retryAt: cursor.retryAt } }
  const every = installation.webhookEnabled ? WEBHOOK_SAFETY_NET_MS : config.pollIntervalMs
  if (!manual && cursor.lastScanAt && now() - cursor.lastScanAt < every - 1000)
    return { summary: "Waiting for the next scan", output: { ingress: "poll" } }
  const scanAt = now()
  try {
    if (!cursor.repositoryId) {
      const repository = (await reader.request<{ id?: number }>("")).data
      if (typeof repository.id !== "number") throw new Error("The repository did not report its id")
      cursor.repositoryId = String(repository.id)
    }
    const { candidates, next } = await pollCandidates(
      reader,
      { id: cursor.repositoryId, fullName: config.repository },
      cursor,
      scanAt
    )
    for (const candidate of candidates) {
      run.signal.throwIfAborted()
      tally(await considerCandidate(ctx, run, config, env, candidate))
    }
    // The cursor moves only after every candidate was handled; a failed scan replays safely.
    await ctx.storage.set(key, next)
    await ctx.bots.recordMonitor(run.runId, {
      lastSuccessAt: scanAt,
      cursor: JSON.stringify({
        ...next,
        ingress: installation.webhookEnabled ? "webhook_ready" : "polling_only",
      }),
    })
    return {
      summary: `Scanned ${candidates.length} comments`,
      output: {
        ingress: installation.webhookEnabled ? "webhook_ready" : "polling_only",
        counts,
      },
    }
  } catch (error) {
    const retryAt =
      error instanceof GithubRequestError && error.rateLimited
        ? error.retryAt
        : error instanceof AuthorCheckUnavailableError
          ? error.decision.retryAt
          : undefined
    if (retryAt) await ctx.storage.set(key, { ...cursor, retryAt })
    await ctx.bots.recordMonitor(run.runId, {
      lastError: error instanceof Error ? error.message : String(error),
      ...(retryAt ? { retryAt } : {}),
    })
    throw error
  }
}

export async function handleCommandRun(
  ctx: PluginContext,
  run: BotRunContextV1,
  now: () => number = Date.now
) {
  run.signal.throwIfAborted()
  try {
    const config = parseConfig(run.config)
    switch (run.event.triggerId) {
      case "execute":
        return await executeCommand(ctx, run, config, now)
      case "reply":
        return await replyToCommand(ctx, run, config, now)
      default:
        return await receiveCommands(ctx, run, config, now)
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    await ctx.bots.recordMonitor(run.runId, { lastError: `${error.code}: ${error.message}` })
    return {
      summary: "Needs setup",
      output: { status: "needs_setup", reasonCode: error.code, message: error.message },
    }
  }
}
