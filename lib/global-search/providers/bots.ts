/**
 * Bots (ADR-0129): every installed Bot, each opening the `/bots` console on
 * its own row.
 *
 * Identity only. A search provider runs on every keystroke, so this reads the
 * installations and joins them to whatever name the registry or the local
 * definitions table already has, rather than assembling full console rows,
 * which would resolve a policy ceiling and a handler module for a list of
 * names.
 *
 * The name is the part worth the join. An installation row carries a
 * `definitionId` and nothing a person would type, so a provider that skipped
 * resolution would only ever match `acme:daily-digest`, never "Daily digest".
 */

import { BotMessageSquareIcon } from "lucide-react"

import { listBotInstallations } from "@/lib/db/bot-installations"
import { getBotDefinition } from "@/lib/db/bot-definitions"
import { getBot } from "@/lib/plugin/registries/bot-registry"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { BotInstallationStatus } from "@/lib/db/bot-types"

import { createListProvider } from "./list-provider"

export const BOTS_PROVIDER_ID = "builtin.bots"

/** The identity subset the palette needs. Never the full console row. */
export interface BotSearchRow {
  id: string
  definitionId: string
  /** The definition's name, or the definition id when nothing resolved. */
  label: string
  status: BotInstallationStatus
  timestamp: number
}

export interface BotsProviderDeps {
  listBotInstallations: () => Promise<readonly BotInstallationRow[]>
  /** The plugin registry overlay. Synchronous, and empty off the app shell. */
  getPluginBotName: (definitionId: string) => string | undefined
  getLocalBotName: (definitionId: string) => Promise<string | undefined>
}

/**
 * The real wiring, kept as a named export so a test can reach it.
 *
 * Every case in this module's suite injects its own `deps`, so nothing here is
 * exercised by them. That is exactly how a wrong read ships green, which is
 * why the defaults are asserted directly.
 */
export const DEFAULT_BOTS_PROVIDER_DEPS: BotsProviderDeps = {
  listBotInstallations: () => listBotInstallations(),
  getPluginBotName: (definitionId) => getBot(definitionId)?.definition.name,
  getLocalBotName: async (definitionId) => (await getBotDefinition(definitionId))?.name,
}

export async function loadBotSearchRows(
  deps: BotsProviderDeps = DEFAULT_BOTS_PROVIDER_DEPS
): Promise<BotSearchRow[]> {
  let installations: readonly BotInstallationRow[]
  try {
    installations = await deps.listBotInstallations()
  } catch (error) {
    // An empty list is a legitimate answer here, so a silent `[]` would make
    // "you have no Bots" and "the read threw" the same result on screen.
    console.warn("global-search/bots: listing installations failed", error)
    return []
  }

  return Promise.all(
    installations.map(async (installation) => ({
      id: installation.id,
      definitionId: installation.definitionId,
      label:
        (installation.definitionSource === "plugin"
          ? deps.getPluginBotName(installation.definitionId)
          : await deps.getLocalBotName(installation.definitionId).catch(() => undefined)) ??
        installation.definitionId,
      status: installation.status,
      timestamp: installation.updatedAt,
    }))
  )
}

export function createBotsProvider(deps: BotsProviderDeps = DEFAULT_BOTS_PROVIDER_DEPS) {
  return createListProvider<BotSearchRow>({
    id: BOTS_PROVIDER_ID,
    kind: "bot",
    load: () => loadBotSearchRows(deps),
    getTitle: (row) => row.label,
    getSecondary: (row) => row.definitionId,
    // The installation id is searchable so a link pasted from a log or a
    // dead-letter report resolves, which is otherwise a manual hunt.
    getKeywords: (row) => [row.definitionId, row.id],
    getTimestamp: (row) => row.timestamp,
    toItem: ({ row, match }, ctx) => ({
      id: `bot:${row.id}`,
      kind: "bot" as const,
      title: row.label,
      titlePositions: match.positions,
      subtitle: row.definitionId,
      meta: ctx.t(`bots.status.${row.status}`),
      icon: { lucide: BotMessageSquareIcon },
      score: match.score,
      timestamp: row.timestamp,
      action: { type: "navigate", href: `/bots?bot=${encodeURIComponent(row.id)}` },
    }),
  })
}

export const botsProvider = createBotsProvider()
