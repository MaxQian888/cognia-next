"use client"

/**
 * Every Bot installed on this device, joined to whatever its definition
 * resolved to.
 *
 * Two reads and one non-Dexie dependency:
 *
 *  * `botInstallations` and the dead-lettered `botEventDeliveries` are Dexie,
 *    so `useLiveQuery` keeps them current on its own.
 *  * A PLUGIN definition is not. It lives in the bot registry overlay, which
 *    `bots-bridge.ts` fills on enable and empties on disable, and a live query
 *    watching Dexie will never re-run for that. Disabling a plugin would leave
 *    its Bots on screen looking healthy until some unrelated row changed. The
 *    enabled-plugin key below is the dependency that makes the join honest.
 *
 * The resolution is deliberately not thrown away when it fails:
 * `resolveInstalledBot` answers `null` for a definition that is gone, and the
 * row model keeps that installation visible as an orphan rather than dropping
 * it. See `lib/bot/console/bot-rows.ts`.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  buildBotRows,
  countDeadLettersByInstallation,
  summarizeBotRows,
  type BotConsoleRow,
  type BotConsoleSummary,
} from "@/lib/bot/console/bot-rows"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { listBotInstallations } from "@/lib/db/bot-installations"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { Plugin } from "@/types/plugin"

/**
 * A stable string that changes exactly when the set of plugins contributing
 * definitions changes.
 *
 * Sorted so a load-order shuffle does not read as a change, and derived from
 * the status rather than the plugin count because a disable keeps the row and
 * only moves it out of `enabled`.
 */
export function enabledPluginKey(plugins: Record<string, Plugin>): string {
  return Object.values(plugins)
    .filter((plugin) => plugin.status === "enabled")
    .map((plugin) => plugin.id)
    .sort()
    .join(",")
}

export interface UseBotInstallationsResult {
  rows: BotConsoleRow[]
  summary: BotConsoleSummary
  /** True until the first read resolves. Distinct from "no Bots installed". */
  loading: boolean
}

export function useBotInstallations(): UseBotInstallationsResult {
  const pluginKey = usePluginStore((state) => enabledPluginKey(state.plugins))

  const rows = useLiveQuery(async () => {
    const [installations, deadLetters] = await Promise.all([
      listBotInstallations(),
      // One pass rather than a query per installation: the console already
      // holds the rows, and a per-row read would be one Dexie round trip per
      // Bot on every live-query tick.
      listBotDeliveries({ status: "deadletter", limit: 500 }),
    ])
    const counts = countDeadLettersByInstallation(deadLetters)
    const resolved = await Promise.all(
      installations.map(async (installation) => ({
        installation,
        resolved: await resolveInstalledBot(installation),
        deadLetters: counts[installation.id] ?? 0,
      }))
    )
    return buildBotRows(resolved)
  }, [pluginKey])

  const summary = useMemo(() => summarizeBotRows(rows ?? []), [rows])

  return { rows: rows ?? [], summary, loading: rows === undefined }
}
