"use client"

/**
 * Every Bot definition this device could install.
 *
 * The same two-world join `useBotInstallations` does, read the other way
 * round, and it needs the same non-Dexie dependency for the same reason: a
 * plugin's definitions live in the registry overlay, which `bots-bridge.ts`
 * fills on enable and empties on disable, and no Dexie live query will ever
 * re-run for that. Without the enabled-plugin key the picker would keep
 * offering Bots from a plugin that had just been switched off.
 *
 * `listBotEntries` is read inside the live query rather than at module scope
 * so the registry is sampled at the same moment the Dexie rows are, which is
 * what keeps the install counts consistent with the list they annotate.
 */

import { useBotHostRead } from "./use-bot-host-read"
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { buildBotCatalog, type BotCatalogEntry } from "@/lib/bot/console/catalog"
import { listBotDefinitions } from "@/lib/db/bot-definitions"
import { listBotInstallations } from "@/lib/db/bot-installations"
import { listBotEntries } from "@/lib/plugin/registries/bot-registry"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

import { enabledPluginKey } from "./use-bot-installations"

export interface UseBotCatalogResult {
  entries: BotCatalogEntry[]
  /** True until the first read resolves. Distinct from "nothing to install". */
  loading: boolean
  failed?: boolean
  remote?: boolean
}

export function useBotCatalog(options: { workspaceId?: string } = {}): UseBotCatalogResult {
  const host = useBotHostRead<{ entries: BotCatalogEntry[] }>("catalog")
  const pluginKey = usePluginStore((state) => enabledPluginKey(state.plugins))
  const workspaceId = options.workspaceId

  const entries = useLiveQuery(async () => {
    const [local, installations] = await Promise.all([
      listBotDefinitions(workspaceId ? { workspaceId } : {}),
      listBotInstallations(),
    ])
    return buildBotCatalog({ registry: listBotEntries(), local, installations })
  }, [pluginKey, workspaceId])

  const available = host.remote ? host.data?.entries : entries
  return useMemo(
    () => ({
      entries: available ?? [],
      failed: host.failed,
      remote: host.remote,
      loading: host.remote ? host.loading : entries === undefined,
    }),
    [available, host.remote, host.loading, host.failed, entries]
  )
}
