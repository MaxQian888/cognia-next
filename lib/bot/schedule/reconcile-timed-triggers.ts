/**
 * Keep an installation's timed triggers and the scheduler in step.
 *
 * `schedule`, `poll` and `derivedState` are declared on a Bot definition and
 * armed per installation, but nothing ever turned an armed one into a row the
 * scheduler would fire. `lib/scheduler/executors/bot-executor.ts` was
 * registered and waiting for a `type: "bot"` task that no code path created,
 * so three of the six trigger kinds could not fire at all.
 *
 * The seam is the one `lib/connectors/presence/usage-status-runner.ts` already
 * uses: a stable tag per subject, read every task, create / update-if-drifted /
 * delete-if-gone, with the scheduler imported lazily so `lib/db` never takes on
 * its module graph.
 *
 * Placement follows ADR-0128 unchanged. `getTaskScheduler()` is always the
 * local scheduler, so each host reconciles only the installations in its own
 * database and no cross-host coordination is owed.
 */

import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { TaskTrigger } from "@/types/scheduler"

/** The task type `lib/scheduler/executors/bot-executor.ts` is registered for. */
export const BOT_TRIGGER_TASK_TYPE = "bot"

/** Groups every Bot-owned schedule, so a sweep can find them without a join. */
export const BOT_TRIGGER_TAG = "system:bot-trigger"

/** Stable tag for the one schedule row a single armed trigger owns. */
export function botTriggerScheduleTag(installationId: string, triggerId: string): string {
  return `bot-trigger:${installationId}:${triggerId}`
}

/**
 * The scheduler trigger a Bot trigger maps to, or `null` when it is not timed.
 *
 * `poll` and `derivedState` are both intervals rather than crons, because both
 * mean "ask again every so often". What separates them is what the handler does
 * with the tick, which is the handler's business and not the scheduler's.
 */
export function schedulerTriggerFor(trigger: PluginBotTriggerDef): TaskTrigger | null {
  switch (trigger.kind) {
    case "schedule":
      return {
        type: "cron",
        cronExpression: trigger.cron,
        ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      }
    case "poll":
    case "derivedState":
      return { type: "interval", intervalMs: trigger.everyMs }
    default:
      return null
  }
}

/** Do two triggers describe the same firing schedule? */
function sameTrigger(a: TaskTrigger, b: TaskTrigger): boolean {
  if (a.type !== b.type) return false
  if (a.type === "cron" && b.type === "cron") {
    return a.cronExpression === b.cronExpression && a.timezone === b.timezone
  }
  if (a.type === "interval" && b.type === "interval") return a.intervalMs === b.intervalMs
  return false
}

async function scheduler() {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return getTaskScheduler()
}

/**
 * Bring one installation's schedule rows in line with its armed triggers.
 *
 * Idempotent, so it is safe to call on every install, every edit, and at boot.
 */
export async function syncBotTriggerSchedules(resolved: InstalledBot): Promise<void> {
  const { isBotTriggerArmed } = await import("@/lib/db/bot-installations")
  const installation = resolved.installation
  // A row this device mirrored from a Host belongs to that Host's scheduler.
  // Reconciling one here would create a local `type: "bot"` task firing the
  // other machine's schedule, and both would run. The fence is here rather
  // than at the two callers because both flow through this function, which is
  // the same reason the delivery fence lives in the queue module.
  if (installation.syncedFromHost === true) return
  const api = await scheduler()
  const all = await api.getAllTasks()
  const prefix = `bot-trigger:${installation.id}:`

  const wanted = new Map<string, { trigger: TaskTrigger; def: PluginBotTriggerDef }>()
  // A disabled installation wants none of them. That is the difference between
  // "turned off" and "deleted": the rows go, the installation stays.
  if (installation.status === "enabled") {
    for (const def of resolved.definition.triggers) {
      const trigger = schedulerTriggerFor(def)
      if (!trigger || !isBotTriggerArmed(installation, def)) continue
      wanted.set(botTriggerScheduleTag(installation.id, def.id), { trigger, def })
    }
  }

  for (const task of all) {
    if (task.type !== BOT_TRIGGER_TASK_TYPE) continue
    const tag = (task.tags ?? []).find((candidate) => candidate.startsWith(prefix))
    if (!tag) continue
    const want = wanted.get(tag)
    if (!want) {
      await api.deleteTask(task.id)
      continue
    }
    wanted.delete(tag)
    if (!sameTrigger(task.trigger, want.trigger) || task.status !== "active") {
      await api.updateTask(task.id, { trigger: want.trigger, status: "active" })
    }
  }

  for (const [tag, want] of wanted) {
    await api.createTask({
      name: `${resolved.definition.name} · ${want.def.label ?? want.def.id}`,
      type: BOT_TRIGGER_TASK_TYPE,
      trigger: want.trigger,
      // Exactly the shape `executeBotTask` reads.
      payload: { installationId: installation.id, triggerId: want.def.id },
      tags: [BOT_TRIGGER_TAG, tag],
      // So the task lists in the workspace that owns the installation rather
      // than in every one of them.
      ...(installation.projectId ? { projectId: installation.projectId } : {}),
    })
  }
}

/** Drop every schedule row an installation owned. Called on uninstall. */
export async function removeBotTriggerSchedules(installationId: string): Promise<void> {
  const api = await scheduler()
  const all = await api.getAllTasks()
  const prefix = `bot-trigger:${installationId}:`
  for (const task of all) {
    if (task.type !== BOT_TRIGGER_TASK_TYPE) continue
    if (!(task.tags ?? []).some((tag) => tag.startsWith(prefix))) continue
    await api.deleteTask(task.id)
  }
}

/**
 * Reconcile every installation on this host, at boot.
 *
 * Picks up rows written before this module existed, and repairs a schedule a
 * crash left half-written. Best-effort by construction: a Bot whose definition
 * no longer resolves is skipped rather than allowed to fail the sweep, and one
 * mirrored from a Host is refused by `syncBotTriggerSchedules` itself.
 */
export async function reconcileAllBotSchedules(): Promise<void> {
  const [{ listBotInstallations }, { resolveInstalledBot }] = await Promise.all([
    import("@/lib/db/bot-installations"),
    import("@/lib/bot/installed-bot"),
  ])
  const installations: BotInstallationRow[] = await listBotInstallations({})
  for (const installation of installations) {
    const resolved = await resolveInstalledBot(installation).catch(() => undefined)
    if (!resolved) continue
    await syncBotTriggerSchedules(resolved).catch(() => undefined)
  }

  // Rows whose installation is gone. `uninstallBot` reaps its own, but an
  // installation removed while this host was down leaves a task that would
  // otherwise fire forever against an id that resolves to nothing.
  const live = new Set(installations.map((installation) => installation.id))
  const api = await scheduler()
  for (const task of await api.getAllTasks()) {
    if (task.type !== BOT_TRIGGER_TASK_TYPE) continue
    const owner = (task.tags ?? []).find((tag) => tag.startsWith("bot-trigger:"))?.split(":")[1]
    if (!owner || live.has(owner)) continue
    await api.deleteTask(task.id).catch(() => undefined)
  }
}
