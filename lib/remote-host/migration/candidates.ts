/**
 * The always-on work this device holds, seen from one paired host
 * (ADR-0224 §Moving an item is a handoff).
 *
 * Three answers the host's device page shows: what still runs here and could
 * be offered to the host, what the host already runs on this device's behalf
 * (each a placeholder here that can be taken back), and which moves or
 * take-backs with this host stopped short and need finishing.
 *
 * A Bot's or connector's own scheduled tasks are left out: they move with the
 * item they belong to (`managedTaskOwner`), so offering them alone would split
 * an item in two.
 */

import type { ItemMigrationRow } from "@/lib/db/item-migrations"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { managedTaskOwner } from "@/lib/placement/machine-bound"
import { isOwnedElsewhere } from "@/lib/placement/ownership"
import type { ItemOwner } from "@/types/placement/item-owner"
import type { ScheduledTask } from "@/types/scheduler"

import { MIGRATION_ORDER } from "./preflight"
import type { MigrationItemRef } from "./types"

export interface AlwaysOnItem {
  ref: MigrationItemRef
  label: string
  owner?: ItemOwner
}

export interface AlwaysOnWork {
  /** Runs on this device; may be offered to the host. */
  local: AlwaysOnItem[]
  /** Runs on this host for this device; a placeholder here. */
  movedHere: AlwaysOnItem[]
  /** The latest operation with this host on an item, where it stopped short. */
  unfinished: ItemMigrationRow[]
}

export interface AlwaysOnSources {
  tasks: readonly ScheduledTask[]
  bots: readonly BotInstallationRow[]
  /** Bot definition id → its name, for labels. */
  botNames: ReadonlyMap<string, string>
  connectors: readonly AdapterInstanceRow[]
  migrations: readonly ItemMigrationRow[]
}

function byKindThenLabel(a: AlwaysOnItem, b: AlwaysOnItem): number {
  return (
    MIGRATION_ORDER.indexOf(a.ref.kind) - MIGRATION_ORDER.indexOf(b.ref.kind) ||
    a.label.localeCompare(b.label)
  )
}

const UNFINISHED: ReadonlySet<ItemMigrationRow["state"]> = new Set([
  "prepared",
  "created",
  "fenced",
  "failed",
  "awaiting-host",
])

/** Pure: sort the sources into what the host's page shows. */
export function buildAlwaysOnWork(sources: AlwaysOnSources, hostId: string): AlwaysOnWork {
  const items: AlwaysOnItem[] = [
    ...sources.tasks
      .filter((task) => !managedTaskOwner(task.type))
      .map((task) => ({
        ref: { kind: "scheduled-task" as const, id: task.id },
        label: task.name,
        ...(task.owner ? { owner: task.owner } : {}),
      })),
    ...sources.bots.map((bot) => ({
      ref: { kind: "bot-installation" as const, id: bot.id },
      label: sources.botNames.get(bot.definitionId) ?? bot.definitionId,
      ...(bot.owner ? { owner: bot.owner } : {}),
    })),
    ...sources.connectors.map((row) => ({
      ref: { kind: "connector-instance" as const, id: row.id },
      label: row.displayName,
      ...(row.owner ? { owner: row.owner } : {}),
    })),
  ]

  const latest = new Map<string, ItemMigrationRow>()
  for (const row of sources.migrations) {
    const key = `${row.itemKind}:${row.itemId}`
    const seen = latest.get(key)
    if (!seen || row.createdAt >= seen.createdAt) latest.set(key, row)
  }

  return {
    local: items.filter((item) => !isOwnedElsewhere(item.owner)).sort(byKindThenLabel),
    movedHere: items
      .filter((item) => isOwnedElsewhere(item.owner) && item.owner.hostId === hostId)
      .sort(byKindThenLabel),
    unfinished: [...latest.values()]
      .filter((row) => row.hostId === hostId && UNFINISHED.has(row.state))
      .sort((a, b) => a.createdAt - b.createdAt),
  }
}

/** Read this device's tables and the journal. Every read is Dexie, so a live query tracks it. */
export async function loadAlwaysOnWork(hostId: string): Promise<AlwaysOnWork> {
  const [
    { getTaskScheduler },
    { listBotInstallations },
    { readHostBotCatalog },
    { listAdapterInstances },
    { listHostItemMigrations },
  ] = await Promise.all([
    import("@/lib/scheduler/task-scheduler"),
    import("@/lib/db/bot-installations"),
    import("@/lib/bot/control-writes/lifecycle-host"),
    import("@/lib/db/adapter-instances"),
    import("@/lib/db/item-migrations"),
  ])
  const [tasks, bots, catalog, connectors, migrations] = await Promise.all([
    getTaskScheduler().getAllTasks(),
    listBotInstallations(),
    readHostBotCatalog(),
    listAdapterInstances(),
    listHostItemMigrations(hostId),
  ])
  return buildAlwaysOnWork(
    {
      tasks,
      bots,
      botNames: new Map(catalog.map((entry) => [entry.definitionId, entry.name])),
      connectors,
      migrations,
    },
    hostId
  )
}
