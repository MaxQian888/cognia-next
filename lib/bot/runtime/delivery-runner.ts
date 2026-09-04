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
  listDueBotDeliveries,
  pruneSettledBotDeliveries,
  renewBotDeliveryLease,
} from "@/lib/db/bot-event-deliveries"
import { getBotInstallation } from "@/lib/db/bot-installations"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { isRunnableBot, resolveInstalledBot } from "@/lib/bot/installed-bot"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

import { runBotDelivery, type BotRunOutcome } from "./run"

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
  /** Resolve the directory a run works in. Absent means the Bot has none. */
  resolveCwd?: (installationId: string) => Promise<string | undefined> | string | undefined
  now?: () => number
}

export interface BotDeliveryAttempt {
  deliveryId: string
  outcome: BotRunOutcome | { status: "skipped"; reason: BotSkipReason }
}

export type BotSkipReason =
  /** Another runner holds a live lease. */
  | "leased_elsewhere"
  /** The installation is gone, disabled, or its plugin is not loaded. */
  | "not_runnable"
  /** Another delivery with the same concurrency key is in flight. */
  | "serialised"

/**
 * Run one pass. Exported so a Host can drive the loop on its own schedule and
 * so tests can step it deterministically instead of waiting on timers.
 */
export async function drainBotDeliveries(
  options: BotDeliveryRunnerOptions
): Promise<BotDeliveryAttempt[]> {
  const now = options.now ?? Date.now
  const due = await listDueBotDeliveries(options.batch ?? BOT_RUNNER_BATCH, now())
  const attempts: BotDeliveryAttempt[] = []

  for (const delivery of due) {
    attempts.push({
      deliveryId: delivery.id,
      outcome: await attemptDelivery(delivery, options, now),
    })
  }
  return attempts
}

async function attemptDelivery(
  delivery: BotEventDeliveryRow,
  options: BotDeliveryRunnerOptions,
  now: () => number
): Promise<BotRunOutcome | { status: "skipped"; reason: BotSkipReason }> {
  // Serialisation is checked BEFORE the claim. Claiming first would make this
  // delivery look in-flight to its own sibling check.
  if (delivery.concurrencyKey) {
    const active = await countActiveBotDeliveriesForKey(delivery.concurrencyKey, now())
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

  const cwd = await options.resolveCwd?.(installation.id)
  const heartbeat = setInterval(() => {
    void renewBotDeliveryLease(claimed.id, options.owner, now())
  }, 30_000)
  try {
    return await runBotDelivery({
      delivery: claimed,
      resolved,
      now,
      ...(cwd ? { cwd } : {}),
    })
  } finally {
    clearInterval(heartbeat)
  }
}

export interface BotDeliveryRunnerHandle {
  stop(): void
}

/**
 * Start the loop. Returns a handle whose `stop` is idempotent.
 *
 * The interval restarts AFTER each pass rather than firing on a fixed cadence,
 * so a slow pass cannot stack passes on top of each other.
 */
export function startBotDeliveryRunner(options: BotDeliveryRunnerOptions): BotDeliveryRunnerHandle {
  const intervalMs = options.intervalMs ?? BOT_RUNNER_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPrune = (options.now ?? Date.now)()

  const tick = async () => {
    if (stopped) return
    try {
      await drainBotDeliveries(options)
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
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
