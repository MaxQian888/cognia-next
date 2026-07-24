/**
 * Periodic driver for the Lark chat-surface reconcile loop.
 *
 * `larkChatSurfaces` carries an exponential backoff (2^n·30 s, capped at 1 h)
 * and `listDueChatSurfaces` selects the rows whose backoff has elapsed — but
 * nothing was ever calling it on a timer. The only triggers were adapter
 * start, a live `bot.added` event, and the settings resync button, so a
 * surface that failed once stayed failed until someone restarted the process
 * or clicked the button. The backoff was, in effect, decoration.
 *
 * Interval is 15 minutes: shorter than the 1 h backoff cap so a capped row
 * still gets its retry, long enough that a fleet of chats sharing one tenant
 * token is not hammering the platform.
 */

import { loggers } from "@cognia/logging"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { startDailySchedule, type DailyScheduleHandle } from "@/lib/connectors/daily-schedule"
import { sweepStaleFeishuBindRequests } from "@/lib/connectors/principal/admin"
import { sweepLarkChatSurfaces } from "./surface-sweep"

export const SURFACE_SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface SurfaceScheduleDependencies {
  listAdapters: typeof listAdapterInstances
  keyringGet: typeof connectorsKeyringGet
  sweep: typeof sweepLarkChatSurfaces
}

function withDefaults(
  overrides: Partial<SurfaceScheduleDependencies>
): SurfaceScheduleDependencies {
  return {
    listAdapters: listAdapterInstances,
    keyringGet: connectorsKeyringGet,
    sweep: sweepLarkChatSurfaces,
    ...overrides,
  }
}

/** One pass over every enabled Lark adapter. Exported for tests. */
export async function sweepAllLarkSurfaces(
  overrides: Partial<SurfaceScheduleDependencies> = {}
): Promise<{ adapters: number; synced: number; errors: number }> {
  const deps = withDefaults(overrides)
  const rows = await deps.listAdapters()
  const totals = { adapters: 0, synced: 0, errors: 0 }
  for (const row of rows) {
    if (row.type !== "lark" || !row.enabled) continue
    totals.adapters += 1
    // Per-adapter isolation: one workspace's expired credentials must not
    // stop every other workspace's surfaces from reconciling.
    try {
      const counts = await deps.sweep({
        adapterId: row.id,
        resolveCreds: async () => {
          const [appId, appSecret] = await Promise.all([
            deps.keyringGet(row.id, "appId"),
            deps.keyringGet(row.id, "appSecret"),
          ])
          return { appId: appId ?? "", appSecret: appSecret ?? "" }
        },
      })
      totals.synced += counts.synced
      totals.errors += counts.errors
    } catch (err) {
      loggers.network.warn("[lark] surface sweep failed", {
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return totals
}

/**
 * Start the periodic surface sweep. The caller MUST dispose the handle on
 * teardown, like every other connector housekeeping timer.
 */
export function startLarkSurfaceSweep(
  options: {
    intervalMs?: number
    initialDelayMs?: number
    scheduler?: Parameters<typeof startDailySchedule>[0]["scheduler"]
    deps?: Partial<SurfaceScheduleDependencies>
  } = {}
): DailyScheduleHandle {
  return startDailySchedule({
    label: "lark-surface-sweep",
    intervalMs: options.intervalMs ?? SURFACE_SWEEP_INTERVAL_MS,
    ...(options.initialDelayMs !== undefined ? { initialDelayMs: options.initialDelayMs } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    task: async () => {
      await sweepAllLarkSurfaces(options.deps ?? {})
    },
  })
}

/**
 * Daily expiry of stale principal bind requests. Codes live 7 days; without a
 * sweep an expired one stayed `pending` forever, so the admin surface kept
 * offering codes that `approveBindRequest` would reject.
 */
export function startBindRequestExpirySweep(
  options: {
    intervalMs?: number
    initialDelayMs?: number
    scheduler?: Parameters<typeof startDailySchedule>[0]["scheduler"]
    sweep?: typeof sweepStaleFeishuBindRequests
  } = {}
): DailyScheduleHandle {
  const sweep = options.sweep ?? sweepStaleFeishuBindRequests
  return startDailySchedule({
    label: "lark-bind-request-expiry",
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.initialDelayMs !== undefined ? { initialDelayMs: options.initialDelayMs } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    task: async () => {
      const expired = await sweep()
      if (expired > 0) {
        loggers.network.info("[lark] expired stale bind requests", { expired })
      }
    },
  })
}
