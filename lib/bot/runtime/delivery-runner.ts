/**
 * The loop that drains the Bot delivery queue.
 *
 * Everything before this point enqueues. This is what makes any of it run, and
 * it is deliberately small: claim a due delivery, resolve what it belongs to,
 * hand it to the run driver, move on. Every decision it could have made is
 * already made somewhere testable (routing in the router, retry in the queue,
 * failure classification in the run driver).
 *
 * One runner per Host, identified by `owner`. The lease on each delivery is
 * what keeps two Hosts from running the same one, and an expired lease is what
 * lets a crashed Host's work be picked up rather than stranded.
 */

import {
  claimBotDelivery,
  countActiveBotDeliveriesForKey,
  dismissBotDelivery,
  findParkedBotDeliveryWaitingFor,
  listDueBotDeliveries,
  pruneSettledBotDeliveries,
  recoverAbandonedBotDelivery,
  renewBotDeliveryLease,
} from "@/lib/db/bot-event-deliveries"
import { getBotInstallation } from "@/lib/db/bot-installations"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { isRunnableBot, resolveInstalledBot } from "@/lib/bot/installed-bot"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

import { resolveBotInstallationCwd } from "./resolve-cwd"
import { botRunId, cancelLiveBotRun, runBotDelivery, type BotRunOutcome } from "./run"

/** How often the loop looks for due deliveries. */
export const BOT_RUNNER_INTERVAL_MS = 2_000

/** How often settled rows are swept. Once an hour is plenty for a 14-day TTL. */
export const BOT_RUNNER_PRUNE_INTERVAL_MS = 60 * 60_000

/** How many deliveries one pass takes. Bounded so one Bot cannot starve others. */
export const BOT_RUNNER_BATCH = 5

export interface BotDeliveryRunnerOptions {
  /** Identifies this runner's lease. One per Host. */
  owner: string
  intervalMs?: number
  batch?: number
  organizationPolicy?: PluginBotPolicyV1
  /**
   * Resolve the directory a run works in.
   *
   * Defaults to `resolveBotInstallationCwd`. It is a default rather than
   * something each caller passes because there are two call sites (the desktop
   * initializer and the headless registration) and neither passed one, which is
   * how `executors/agent-turn.ts` came to refuse every run it was handed.
   */
  resolveCwd?: (installationId: string) => Promise<string | undefined> | string | undefined
  now?: () => number
  /** Internal host shutdown cancellation. */
  signal?: AbortSignal
}

export interface BotDeliveryAttempt {
  deliveryId: string
  outcome: BotRunOutcome | { status: "skipped"; reason: BotSkipReason }
}

export type BotSkipReason =
  /** Another runner holds a live lease. */
  | "leased_elsewhere"
  /**
   * The previous attempt was abandoned by a host that stopped. It has been
   * charged one attempt and returned to the queue, and comes back after its
   * backoff rather than being re-run in the same pass.
   */
  | "recovered"
  /** The installation is gone, disabled, or its plugin is not loaded. */
  | "not_runnable"
  /** Another delivery with the same concurrency key is in flight. */
  | "serialised"
  /**
   * A run is already parked on this event's correlation key. The row stays so
   * that run can read its envelope on re-entry, but starting a second run for
   * the answer the first one asked for would be a duplicate.
   */
  | "consumed_by_wait"

/**
 * Run one pass. Exported so a Host can drive the loop on its own schedule and
 * so tests can step it deterministically instead of waiting on timers.
 */
export async function drainBotDeliveries(
  options: BotDeliveryRunnerOptions
): Promise<BotDeliveryAttempt[]> {
  const now = options.now ?? Date.now
  // Select runnable, distinct keys BEFORE applying the batch limit. Otherwise
  // a busy repository's pending prefix can indefinitely starve its monitor.
  // The claim still checks concurrency atomically against competing passes.
  const due = await listDueBotDeliveries(options.batch ?? BOT_RUNNER_BATCH, now(), true)

  return Promise.all(
    due.map(async (delivery) => ({
      deliveryId: delivery.id,
      outcome: await attemptDelivery(delivery, options, now),
    }))
  )
}

async function attemptDelivery(
  delivery: BotEventDeliveryRow,
  options: BotDeliveryRunnerOptions,
  now: () => number
): Promise<BotRunOutcome | { status: "skipped"; reason: BotSkipReason }> {
  // A run parked on this correlation is the intended recipient. Checked before
  // the claim so the row is left exactly as `findBotDeliveryByCorrelation`
  // expects to find it.
  if (delivery.correlation) {
    const waiting = await findParkedBotDeliveryWaitingFor(
      delivery.installationId,
      delivery.correlation
    )
    if (waiting && waiting.id !== delivery.id) {
      await dismissBotDelivery(delivery.id, "consumed by a waiting run", now())
      return { status: "skipped", reason: "consumed_by_wait" }
    }
  }

  // Recovery runs BEFORE the claim, for the same reason serialisation does: the
  // claim rewrites the row, so afterwards nothing can tell an attempt that was
  // abandoned from one that is simply starting.
  const recovery = await recoverAbandonedBotDelivery(delivery.id, now())
  if (recovery) return { status: "skipped", reason: "recovered" }

  // Serialisation is checked BEFORE the claim. Claiming first would make this
  // delivery look in-flight to its own sibling check.
  if (delivery.concurrencyKey) {
    const active = await countActiveBotDeliveriesForKey(delivery.concurrencyKey, now(), delivery.id)
    if (active > 0) return { status: "skipped", reason: "serialised" }
  }

  const claimed = await claimBotDelivery(delivery.id, options.owner, now())
  if (!claimed) return { status: "skipped", reason: "leased_elsewhere" }

  const installation = await getBotInstallation(claimed.installationId)
  if (!installation) {
    await dismissBotDelivery(claimed.id, "installation was removed", now())
    return { status: "skipped", reason: "not_runnable" }
  }

  const resolved = await resolveInstalledBot(installation, {
    ...(options.organizationPolicy ? { organizationPolicy: options.organizationPolicy } : {}),
  })
  if (!resolved || !isRunnableBot(resolved)) {
    // Dismissed rather than retried: a disabled installation or an unloaded
    // plugin will not become runnable by waiting.
    await dismissBotDelivery(claimed.id, "installation is not runnable", now())
    return { status: "skipped", reason: "not_runnable" }
  }

  const cwd = await (options.resolveCwd ?? resolveBotInstallationCwd)(installation.id)
  // The run driver settles an already-owned claim even if shutdown happened
  // during workspace resolution; skipping here would strand the live lease.
  const cancel = () => cancelLiveBotRun(botRunId(claimed.id))
  options.signal?.addEventListener("abort", cancel, { once: true })
  const heartbeat = setInterval(() => {
    void (async () => {
      const latest = await getBotInstallation(installation.id)
      if (!latest || latest.status !== "enabled" || !(await resolveInstalledBot(latest))) cancel()
      if (!(await renewBotDeliveryLease(claimed.id, options.owner, now()))) cancel()
    })().catch(cancel)
  }, 30_000)
  try {
    return await runBotDelivery({
      delivery: claimed,
      resolved,
      now,
      signal: options.signal,
      ...(cwd ? { cwd } : {}),
    })
  } finally {
    clearInterval(heartbeat)
    options.signal?.removeEventListener("abort", cancel)
  }
}

export interface BotDeliveryRunnerHandle {
  stop(): void
}

/**
 * Start the loop. Returns a handle whose `stop` is idempotent.
 *
 * Bounded overlapping passes let monitoring continue during long executions.
 * Delivery leases still prevent an overlapping pass from executing the same work.
 */
export function startBotDeliveryRunner(options: BotDeliveryRunnerOptions): BotDeliveryRunnerHandle {
  const intervalMs = options.intervalMs ?? BOT_RUNNER_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPrune = (options.now ?? Date.now)()
  const controller = new AbortController()
  const passes = new Set<Promise<unknown>>()

  const tick = async () => {
    if (stopped) return
    try {
      // A long external execution must not suspend polling for every Bot.
      // Claims fence overlapping passes; bound outstanding passes as well.
      if (passes.size < (options.batch ?? BOT_RUNNER_BATCH)) {
        const pass = drainBotDeliveries({ ...options, signal: controller.signal })
        passes.add(pass)
        void pass.catch(() => undefined).finally(() => passes.delete(pass))
      }
      const now = (options.now ?? Date.now)()
      if (now - lastPrune >= BOT_RUNNER_PRUNE_INTERVAL_MS) {
        lastPrune = now
        await pruneSettledBotDeliveries(now)
      }
    } catch {
      // A pass that threw must not kill the loop: the next one may well work,
      // and a dead runner is a queue that silently stops draining.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)

  return {
    stop() {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
