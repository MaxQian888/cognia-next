/**
 * Schedule digest, the reference Bot.
 *
 * `bots-bridge.ts` and the whole `bot` capability had no in-tree consumer, so
 * the plugin half of the Bot control plane was a bridge nothing had ever
 * crossed. This is the first crossing, and it is deliberately the smallest one
 * that exercises every part that could be wrong:
 *
 *  * `executor: "handler"`, which is the only executor that resolves a module
 *    at all, so it is the only one that can fail to resolve.
 *  * `step.run`, which is what a handler must use for anything that must not
 *    happen twice. A handler is re-entered FROM THE TOP after a crash, a Host
 *    handover or a resumed wait.
 *  * A `schedule` trigger, so the reconciler has a real cron to turn into a
 *    `type: "bot"` scheduler row, and a `manual` one so "Run now" has
 *    something to attribute a run to.
 *  * A `configSchema`, so the installation's settings form has fields.
 *
 * ## Why the scheduler is the right subject
 *
 * It is the one event source that needs no external credential. This Bot
 * therefore installs and runs end to end with nothing configured, which is
 * what makes it usable as an acceptance path rather than a demo that needs a
 * GitHub account first.
 *
 * ## Why the handler closes over a captured context
 *
 * `BotRunContextV1` carries no `PluginContext`, and that is deliberate rather
 * than an omission: the same context has to be handed to a Python handler
 * across stdio, where a live object with methods cannot go. So a JS handler
 * reaches its plugin's capabilities the way any module export would, through
 * what `activate` captured. {@link createScheduleDigestBot} takes its
 * dependencies instead, so the logic is testable without a plugin runtime.
 */

import { defineBot, defineBotHandler } from "@cognia/plugin-sdk"
import type { BotHandlerV1, ScheduledTask } from "@cognia/plugin-sdk"

/** Days after which a task that has never run is worth mentioning. */
export const DEFAULT_STALE_AFTER_DAYS = 14

export interface ScheduleDigest {
  total: number
  active: number
  paused: number
  /** Names of active tasks that have not run within the stale window. */
  stale: string[]
  /** Names of active tasks whose last run failed. */
  failing: string[]
}

/**
 * The digest, as a pure function.
 *
 * `stale` counts an active task that has NEVER run as stale once it is older
 * than the window. A task created six weeks ago that has still not fired is
 * exactly the thing a digest exists to surface, and keying only on `lastRunAt`
 * would skip it because there is no last run to be old.
 */
export function buildScheduleDigest(
  tasks: readonly ScheduledTask[],
  now: number,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS
): ScheduleDigest {
  const cutoff = now - Math.max(1, staleAfterDays) * 24 * 60 * 60_000
  const active = tasks.filter((task) => task.status === "active")
  const stale: string[] = []
  const failing: string[] = []
  for (const task of active) {
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt).getTime() : undefined
    const reference = lastRun ?? new Date(task.createdAt).getTime()
    if (reference < cutoff) stale.push(task.name)
    // `lastError` alone is not enough: a task that failed once and has since
    // succeeded keeps the message. The counter is what says it is failing NOW.
    if ((task.consecutiveFailures ?? 0) > 0) failing.push(task.name)
  }
  return {
    total: tasks.length,
    active: active.length,
    paused: tasks.filter((task) => task.status === "paused").length,
    stale,
    failing,
  }
}

/** The plugin's `ctx.i18n.t`: keys live in plugin.json `i18n.locales`. */
export type DigestTranslate = (key: string, params?: Record<string, string | number>) => string

/**
 * One line for the run list, in the user's language. Plain text, because that
 * is what a summary is.
 */
export function describeScheduleDigest(digest: ScheduleDigest, t: DigestTranslate): string {
  const parts = [t("digest.active", { active: digest.active, total: digest.total })]
  if (digest.paused > 0) parts.push(t("digest.paused", { count: digest.paused }))
  if (digest.failing.length > 0) parts.push(t("digest.failing", { count: digest.failing.length }))
  if (digest.stale.length > 0) parts.push(t("digest.stale", { count: digest.stale.length }))
  return parts.join(t("digest.separator"))
}

export interface ScheduleDigestDeps {
  listTasks: () => Promise<ScheduledTask[]>
  /** Resolves the digest's user-facing text at run time, in the current locale. */
  t: DigestTranslate
  now?: () => number
}

/**
 * The handler, with its one capability injected.
 *
 * The read is inside `step.run`, which is not about cost here but about
 * meaning: on a re-entry the digest is the one that was taken when the run
 * started, so a retry reports the same numbers the first attempt did rather
 * than a fresh snapshot of a schedule that has since changed.
 */
export function createScheduleDigestBot(deps: ScheduleDigestDeps): BotHandlerV1 {
  return defineBotHandler(async (ctx) => {
    const staleAfterDays =
      typeof ctx.config.staleAfterDays === "number"
        ? ctx.config.staleAfterDays
        : DEFAULT_STALE_AFTER_DAYS

    const digest = await ctx.step.run("read-schedule", async () => {
      const tasks = await deps.listTasks()
      return buildScheduleDigest(tasks, (deps.now ?? Date.now)(), staleAfterDays)
    })

    ctx.progress({ fraction: 1, message: deps.t("digest.progress") })
    if (digest.failing.length > 0) {
      ctx.log("warn", "scheduled tasks are failing", { names: digest.failing })
    }

    return { summary: describeScheduleDigest(digest, deps.t), output: digest }
  })
}

/**
 * The manifest entry.
 *
 * `entry` names the plugin's own index rather than this file, because a
 * built-in plugin is resolved through its registry entry's `moduleExports`
 * and never through a path. Naming the index keeps the two loading paths, the
 * built-in one and a real file install, pointing at the same module.
 */
export const scheduleDigestBotDef = defineBot({
  id: "schedule-digest",
  name: "Schedule digest",
  description: "Reports how many scheduled tasks are active, paused, failing or stale.",
  version: "1.0.0",
  executor: "handler",
  entry: "src/index.ts",
  export: "scheduleDigestBot",
  triggers: [
    {
      id: "daily",
      kind: "schedule",
      label: "Every morning",
      cron: "0 9 * * *",
      // Off until somebody asks for it. The Bot reads the user's whole
      // schedule, and a contribution that arms itself on install is the
      // pattern `enabledByDefault` exists to make deliberate.
      enabledByDefault: false,
    },
    { id: "now", kind: "manual", label: "Digest now" },
  ],
  policy: {
    // A real ceiling, not a placeholder: the run is two Dexie reads, so
    // anything longer means something is wrong, and a second concurrent digest
    // of the same schedule is never useful.
    maxRunDurationMs: 30_000,
    maxConcurrentRuns: 1,
  },
  configSchema: {
    type: "object",
    properties: {
      staleAfterDays: {
        type: "number",
        title: "Stale after (days)",
        description: "An active task that has not run in this long is called out.",
        default: DEFAULT_STALE_AFTER_DAYS,
      },
    },
  },
})
