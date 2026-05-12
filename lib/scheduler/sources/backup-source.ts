/**
 * Backup-source adapter: surfaces the single `appSettings.backupAutoSchedule`
 * row as one unified scheduled item.
 *
 * Backup scheduling is config-driven (every N days), not cron, so the
 * trigger summary uses the `interval` type. Capability scope:
 *
 *   - read: full
 *   - pause / resume: toggles `enabled` on the config
 *   - update: lets the user change `intervalDays` / `dirPath` / `retainCount`
 *   - runNow: invokes `runOnce()` (the same path the scheduler provider uses)
 *   - create / delete: not applicable — the row is a singleton config
 */

import { DEFAULT_BACKUP_AUTO_SCHEDULE, type BackupAutoSchedule } from "@/lib/claude/types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { runOnce as runBackupOnce } from "@/components/providers/backup-scheduler-provider"
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

export const BACKUP_SOURCE_ID = "default"
const POLL_INTERVAL_MS = 60_000

export interface BackupSourceDeps {
  read?: () => Promise<BackupAutoSchedule | undefined>
  write?: (next: BackupAutoSchedule) => Promise<void>
  runNow?: () => Promise<boolean>
  /**
   * Optional poller — defaults to a setInterval(1min) re-read. Tests inject
   * a synchronous tick.
   */
  pollIntervalMs?: number
}

export function createBackupSource(
  deps: BackupSourceDeps = {}
): ScheduledItemSource<BackupAutoSchedule, Partial<BackupAutoSchedule>> {
  const read =
    deps.read ??
    (async () => {
      const settings = await getSettings()
      return settings.backupAutoSchedule
    })
  const write =
    deps.write ??
    (async (next: BackupAutoSchedule) => {
      await saveSettings({ backupAutoSchedule: next })
    })
  const runNow = deps.runNow ?? runBackupOnce
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS

  return {
    kind: "backup",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      let cancelled = false
      const emit = async () => {
        try {
          const cfg = await read()
          if (cancelled) return
          observer.next([toUnifiedBackup(cfg)])
        } catch (err) {
          observer.error?.(err)
        }
      }
      void emit()
      const timer =
        pollMs > 0 && typeof setInterval === "function"
          ? setInterval(() => void emit(), pollMs)
          : null
      return {
        unsubscribe() {
          cancelled = true
          if (timer) clearInterval(timer)
        },
      }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      const cfg = await read()
      return [toUnifiedBackup(cfg)]
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      if (sourceId !== BACKUP_SOURCE_ID) return undefined
      const cfg = await read()
      return toUnifiedBackup(cfg)
    },

    async create(input: BackupAutoSchedule): Promise<UnifiedScheduledItem> {
      await write({ ...DEFAULT_BACKUP_AUTO_SCHEDULE, ...input })
      const cfg = await read()
      return toUnifiedBackup(cfg)
    },

    async update(_sourceId, input): Promise<void> {
      const current = (await read()) ?? DEFAULT_BACKUP_AUTO_SCHEDULE
      await write({ ...current, ...input })
    },

    async delete(): Promise<void> {
      // Reset to defaults — the singleton row always exists conceptually.
      await write({ ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: false })
    },

    async pause(): Promise<void> {
      const current = (await read()) ?? DEFAULT_BACKUP_AUTO_SCHEDULE
      await write({ ...current, enabled: false })
    },

    async resume(): Promise<void> {
      const current = (await read()) ?? DEFAULT_BACKUP_AUTO_SCHEDULE
      await write({ ...current, enabled: true })
    },

    async runNow(): Promise<void> {
      await runNow()
    },
  }
}

export function toUnifiedBackup(cfg: BackupAutoSchedule | undefined): UnifiedScheduledItem {
  const resolved = cfg ?? DEFAULT_BACKUP_AUTO_SCHEDULE
  const intervalMs = resolved.intervalDays * 24 * 60 * 60 * 1000
  const lastRunAt = resolved.lastRunAt ? Date.parse(resolved.lastRunAt) : undefined
  const nextRunAt =
    resolved.enabled && lastRunAt && Number.isFinite(lastRunAt) ? lastRunAt + intervalMs : undefined
  return {
    unifiedId: makeUnifiedId("backup", BACKUP_SOURCE_ID),
    kind: "backup",
    sourceId: BACKUP_SOURCE_ID,
    name: "Automatic backup",
    description: resolved.dirPath ? `Encrypted backup to ${resolved.dirPath}` : undefined,
    status: mapBackupStatus(resolved),
    triggerSummary: {
      type: "interval",
      intervalMs,
    },
    nextRunAt,
    lastRunAt,
    origin: {
      deepLinkHref: "/settings?section=data&dataTab=backup",
    },
    capabilities: { runNow: true, pause: true, edit: true, delete: false },
  }
}

function mapBackupStatus(cfg: BackupAutoSchedule): UnifiedItemStatus {
  if (!cfg.enabled) return "paused"
  if (!cfg.dirPath) return "disabled"
  return "active"
}
