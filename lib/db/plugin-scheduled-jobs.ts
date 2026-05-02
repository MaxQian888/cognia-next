// Plugin scheduled-jobs table CRUD (Dexie v15 — §A-Schema).
//
// One row per scheduled task contributed by a plugin. The plugin scheduler
// executor (`lib/scheduler/executors/plugin-executor.ts`, §B-2) consults
// these rows on tick to dispatch work back to the plugin's handler.

import type { PluginScheduledJobRow } from "./plugin-types"
import { getDb } from "./schema"

function newId() {
  return "pjob_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listAllScheduledJobs(): Promise<PluginScheduledJobRow[]> {
  return getDb().pluginScheduledJobs.toArray()
}

export async function listActiveScheduledJobs(): Promise<PluginScheduledJobRow[]> {
  return getDb().pluginScheduledJobs.where("status").equals("active").toArray()
}

export async function listScheduledJobsForPlugin(
  pluginId: string
): Promise<PluginScheduledJobRow[]> {
  return getDb().pluginScheduledJobs.where("pluginId").equals(pluginId).toArray()
}

export async function getScheduledJob(id: string): Promise<PluginScheduledJobRow | undefined> {
  return getDb().pluginScheduledJobs.get(id)
}

export type PluginScheduledJobDraft = Pick<PluginScheduledJobRow, "pluginId" | "cron" | "handler"> &
  Partial<Pick<PluginScheduledJobRow, "id" | "args" | "status" | "nextRunAt">>

export async function createScheduledJob(
  draft: PluginScheduledJobDraft
): Promise<PluginScheduledJobRow> {
  const now = Date.now()
  const row: PluginScheduledJobRow = {
    id: draft.id || newId(),
    pluginId: draft.pluginId,
    cron: draft.cron,
    handler: draft.handler,
    args: draft.args,
    status: draft.status ?? "active",
    nextRunAt: draft.nextRunAt,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().pluginScheduledJobs.put(row)
  return row
}

export async function updateScheduledJob(
  id: string,
  patch: Partial<Omit<PluginScheduledJobRow, "id" | "createdAt">>
): Promise<void> {
  await getDb().pluginScheduledJobs.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteScheduledJob(id: string): Promise<void> {
  await getDb().pluginScheduledJobs.delete(id)
}

/** Drop every job for the plugin. Called on disable / uninstall. */
export async function deleteScheduledJobsForPlugin(pluginId: string): Promise<number> {
  const rows = await listScheduledJobsForPlugin(pluginId)
  await Promise.all(rows.map((r) => deleteScheduledJob(r.id)))
  return rows.length
}
