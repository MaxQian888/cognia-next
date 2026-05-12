/**
 * Plugin-source adapter: surfaces every row in the `pluginScheduledJobs`
 * Dexie table as a unified scheduled item.
 *
 * Capability scope:
 *   - read: full
 *   - pause / resume: flip `status` between "active" and "paused"
 *   - update: cron / args
 *   - delete: removes the row (plugin can re-register on next load)
 *   - runNow: not surfaced here — depends on plugin runtime; UI hides the
 *     action because the capability bit is false
 *   - create: not supported — plugins register their own jobs via their
 *     manifest; the UI deep-links to the plugin settings instead
 */

import { liveQuery } from "dexie"
import { getDb } from "@/lib/db/schema"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"
import {
  makeUnifiedId,
  type UnifiedScheduledItem,
  type UnifiedItemStatus,
} from "@/types/scheduler/unified"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
  ScheduledItemSubscription,
} from "./types"

export class PluginSourceWriteNotSupportedError extends Error {
  constructor(action: string) {
    super(
      `Plugin job ${action} is not supported — plugins register their jobs via manifest; manage them in plugin settings.`
    )
    this.name = "PluginSourceWriteNotSupportedError"
  }
}

interface PluginSourceDb {
  pluginScheduledJobs: {
    toArray(): Promise<PluginScheduledJobRow[]>
    get(id: string): Promise<PluginScheduledJobRow | undefined>
    update(id: string, changes: Partial<PluginScheduledJobRow>): Promise<number>
    delete(id: string): Promise<void>
  }
}

export interface PluginRawObservable {
  subscribe(observer: { next(rows: PluginScheduledJobRow[]): void; error?(err: unknown): void }): {
    unsubscribe(): void
  }
}

export interface PluginSourceDeps {
  db?: PluginSourceDb
  observe?: (querier: () => Promise<PluginScheduledJobRow[]>) => PluginRawObservable
}

export function createPluginSource(
  deps: PluginSourceDeps = {}
): ScheduledItemSource<never, Partial<Pick<PluginScheduledJobRow, "cron" | "args" | "status">>> {
  const db = deps.db ?? (getDb() as unknown as PluginSourceDb)
  const observe = deps.observe ?? ((querier) => liveQuery(querier))

  return {
    kind: "plugin",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      const sub = observe(() => db.pluginScheduledJobs.toArray()).subscribe({
        next: (rows: PluginScheduledJobRow[]) => observer.next(rows.map(toUnifiedPluginJob)),
        error: (err: unknown) => observer.error?.(err),
      })
      return { unsubscribe: () => sub.unsubscribe() }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      const rows = await db.pluginScheduledJobs.toArray()
      return rows.map(toUnifiedPluginJob)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      const row = await db.pluginScheduledJobs.get(sourceId)
      return row ? toUnifiedPluginJob(row) : undefined
    },

    create(): Promise<UnifiedScheduledItem> {
      return Promise.reject(new PluginSourceWriteNotSupportedError("create"))
    },

    async update(sourceId, input): Promise<void> {
      const changes: Partial<PluginScheduledJobRow> = {}
      if (typeof input.cron === "string") changes.cron = input.cron
      if (input.args !== undefined) changes.args = input.args
      if (typeof input.status === "string") changes.status = input.status
      if (Object.keys(changes).length === 0) return
      changes.updatedAt = Date.now()
      await db.pluginScheduledJobs.update(sourceId, changes)
    },

    async delete(sourceId: string): Promise<void> {
      await db.pluginScheduledJobs.delete(sourceId)
    },

    async pause(sourceId: string): Promise<void> {
      await db.pluginScheduledJobs.update(sourceId, {
        status: "paused",
        updatedAt: Date.now(),
      })
    },

    async resume(sourceId: string): Promise<void> {
      await db.pluginScheduledJobs.update(sourceId, {
        status: "active",
        updatedAt: Date.now(),
      })
    },

    runNow(): Promise<void> {
      // Plugin jobs don't expose an idempotent run-now today.
      return Promise.reject(new PluginSourceWriteNotSupportedError("runNow"))
    },
  }
}

export function toUnifiedPluginJob(row: PluginScheduledJobRow): UnifiedScheduledItem {
  return {
    unifiedId: makeUnifiedId("plugin", row.id),
    kind: "plugin",
    sourceId: row.id,
    name: `${row.pluginId} · ${row.handler}`,
    description: row.cron,
    status: mapPluginStatus(row.status),
    triggerSummary: {
      type: "cron",
      cron: row.cron,
    },
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    origin: {
      tableName: "pluginScheduledJobs",
      deepLinkHref: `/settings?section=plugins&pluginId=${encodeURIComponent(row.pluginId)}`,
    },
    capabilities: { runNow: false, pause: true, edit: true, delete: true },
  }
}

function mapPluginStatus(status: string): UnifiedItemStatus {
  if (status === "active" || status === "paused" || status === "disabled" || status === "expired") {
    return status
  }
  if (status === "error") return "disabled"
  return "unknown"
}
