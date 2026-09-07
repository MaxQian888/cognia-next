/**
 * What can be installed: every Bot definition this device can see, from both
 * worlds, joined to how many installations already point at it.
 *
 * The two worlds are the same split `resolveInstalledBot` joins in the other
 * direction. A plugin's definitions live in the bot registry overlay and come
 * and go with the plugin. A person's live in `botDefinitions`. The picker has
 * to enumerate both, and nothing else in the tree does, so the join is here
 * rather than inside the sheet.
 *
 * Two shape decisions worth stating.
 *
 * A definition that is ALREADY installed stays in the catalogue. Installing a
 * second copy is a real thing to want: two schedules on the same digest Bot,
 * or one instance per workspace, and the row carries the count so the choice
 * is informed rather than blocked. What the count prevents is the other
 * failure, a user reinstalling something they forgot they had.
 *
 * `handler` definitions whose module never resolved are listed and marked. An
 * installation of one would be immediately `handler_missing`, and hiding the
 * definition would leave a user hunting for a Bot their plugin clearly
 * advertises. The install control is what refuses, with the reason.
 */

import type { BotDefinitionRow, BotInstallationRow } from "@/lib/db/bot-types"
import type { RegisteredBot } from "@/lib/plugin/registries/bot-registry"
import type {
  PluginBotCredentialSlot,
  PluginBotExecutor,
  PluginBotTriggerDef,
} from "@/types/plugin/plugin-bot"

/** One installable definition, from either world. */
export interface BotCatalogEntry {
  /** The id an installation pins. Namespaced for a plugin definition. */
  definitionId: string
  source: "plugin" | "local"
  name: string
  description?: string
  version: string
  executor: PluginBotExecutor
  triggers: readonly PluginBotTriggerDef[]
  /** Required slots only. An optional slot never blocks an install. */
  requiredSlots: readonly PluginBotCredentialSlot[]
  /** Every slot, so the sheet can preview what setup will ask for. */
  slots: readonly PluginBotCredentialSlot[]
  /** Whether the definition ships a per-installation configuration form. */
  configSchema?: Record<string, unknown>
  /** Owning plugin, for a plugin definition. */
  pluginId?: string
  /** Installations already pointing at this definition. */
  installedCount: number
  /**
   * A `handler` definition whose module did not resolve. Installing it would
   * produce a Bot that can never run, so the sheet says so and refuses.
   */
  unresolvedHandler: boolean
}

export interface BotCatalogInput {
  /** `listBotEntries()` from the plugin bot registry. */
  registry: ReadonlyArray<{ id: string; entry: RegisteredBot; pluginId?: string }>
  /** `listBotDefinitions()` from Dexie. */
  local: readonly BotDefinitionRow[]
  /** Every installation on this device, for the counts. */
  installations: readonly BotInstallationRow[]
}

function countByDefinition(installations: readonly BotInstallationRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const installation of installations) {
    counts[installation.definitionId] = (counts[installation.definitionId] ?? 0) + 1
  }
  return counts
}

/**
 * The catalogue, plugin definitions first and each half alphabetical.
 *
 * Plugin definitions lead because they are the ones a user just installed a
 * plugin to get, and the registry's own order is registration order, which is
 * plugin load order and means nothing to a reader.
 */
export function buildBotCatalog(input: BotCatalogInput): BotCatalogEntry[] {
  const counts = countByDefinition(input.installations)

  const fromPlugins: BotCatalogEntry[] = input.registry.map(({ id, entry, pluginId }) => {
    const def = entry.definition
    const slots = def.requires?.credentials ?? []
    return {
      definitionId: id,
      source: "plugin",
      name: def.name,
      version: def.version,
      executor: def.executor,
      triggers: def.triggers,
      slots,
      requiredSlots: slots.filter((slot) => !slot.optional),
      installedCount: counts[id] ?? 0,
      unresolvedHandler: def.executor === "handler" && !entry.handler,
      ...(def.description ? { description: def.description } : {}),
      ...(def.configSchema ? { configSchema: def.configSchema } : {}),
      ...(pluginId ? { pluginId } : {}),
    }
  })

  const fromLocal: BotCatalogEntry[] = input.local.map((row) => {
    const slots = row.requires?.credentials ?? []
    return {
      definitionId: row.id,
      source: "local",
      name: row.name,
      version: row.version,
      executor: row.executor,
      triggers: row.triggers,
      slots,
      requiredSlots: slots.filter((slot) => !slot.optional),
      installedCount: counts[row.id] ?? 0,
      // A local definition has no module to resolve. `handler` is not even in
      // `LocalBotExecutor`, so this can never be true here.
      unresolvedHandler: false,
      ...(row.description ? { description: row.description } : {}),
      ...(row.configSchema ? { configSchema: row.configSchema } : {}),
    }
  })

  const byName = (a: BotCatalogEntry, b: BotCatalogEntry) => a.name.localeCompare(b.name)
  return [...fromPlugins.sort(byName), ...fromLocal.sort(byName)]
}

/** Free-text match over the fields a person would type. */
export function matchesCatalogSearch(entry: BotCatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [entry.name, entry.description, entry.definitionId, entry.pluginId]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle))
}

export function filterBotCatalog(
  entries: readonly BotCatalogEntry[],
  query: string
): BotCatalogEntry[] {
  return entries.filter((entry) => matchesCatalogSearch(entry, query))
}

/**
 * Can this definition be installed at all?
 *
 * Only the unresolved handler refuses. A missing credential does NOT: the
 * installation is created `needs_setup` on purpose, so a user can install
 * first and bind afterwards, which is the order the detail pane is built for.
 */
export function catalogEntryInstallable(entry: BotCatalogEntry): boolean {
  return !entry.unresolvedHandler
}
