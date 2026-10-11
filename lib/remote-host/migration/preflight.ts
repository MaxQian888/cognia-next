/**
 * Preflight for moving always-on work to a paired host (ADR-0224 step 1).
 *
 * Asked before anything is sent and again right before the move, because the
 * host can change in between. Answers per item, with every blocker listed:
 * protocol (the host advertises `always-on.migration`), machine-bound reasons
 * from the one classifier, plugins and their versions, the things the item
 * names (workflows, agents, workspaces, accounts…), id conflicts, and secrets
 * that cannot be read here to carry over.
 *
 * Items are checked as a batch: a Bot bound to a connector instance that is
 * moving in the same batch does not wait on it, because the service moves
 * connectors first.
 */

import {
  ALWAYS_ON_MIGRATION_HOST_OPERATIONS,
  supportsHostFeatureOperation,
} from "@/lib/platform/host-feature-manifest"
import type { Platform } from "@/lib/platform/detect"
import { isOwnedElsewhere } from "@/lib/placement/ownership"
import { latestItemMigration } from "@/lib/db/item-migrations"
import type { OwnedItemKind } from "@/types/placement/item-owner"

import type { HostFacts } from "./host-facts"
import { checkItem, loadItem, type LoadedItem } from "./items"
import type { MigrationBlocker, MigrationItemRef, MigrationPreflight } from "./types"

/** The order a batch moves in: what others depend on goes first. */
export const MIGRATION_ORDER: readonly OwnedItemKind[] = [
  "connector-instance",
  "bot-installation",
  "scheduled-task",
]

export function sortForMigration<T extends { kind: OwnedItemKind }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => MIGRATION_ORDER.indexOf(a.kind) - MIGRATION_ORDER.indexOf(b.kind)
  )
}

export interface PreflightDeps {
  load?: (ref: MigrationItemRef) => Promise<LoadedItem | undefined>
  now?: () => number
}

/** True when an earlier move of this item stopped partway and will be resumed. */
async function isResumingMove(ref: MigrationItemRef): Promise<boolean> {
  const latest = await latestItemMigration(ref.kind, ref.id)
  return (
    latest?.direction === "move" && latest.state !== "completed" && latest.state !== "awaiting-host"
  )
}

function hostReceivesMigrations(
  manifest: Awaited<ReturnType<HostFacts["manifest"]>>
): manifest is NonNullable<typeof manifest> {
  return (
    manifest !== null &&
    ALWAYS_ON_MIGRATION_HOST_OPERATIONS.every((operation) =>
      supportsHostFeatureOperation(manifest, "always-on.migration", operation)
    )
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Preflight a batch against one host's facts. Pure apart from reading this
 * machine's tables and the journal; the caller owns the channel the facts
 * read through.
 */
export async function preflightItems(
  refs: readonly MigrationItemRef[],
  facts: HostFacts,
  deps: PreflightDeps = {}
): Promise<MigrationPreflight[]> {
  const load = deps.load ?? loadItem
  const now = deps.now ?? Date.now
  const checkedAt = now()

  let shared: MigrationBlocker[] = []
  let platform: Platform = "headless"
  try {
    const manifest = await facts.manifest()
    if (!hostReceivesMigrations(manifest)) shared = [{ kind: "host-too-old" }]
    else platform = manifest.platform
  } catch (error) {
    shared = [{ kind: "host-unreachable", detail: message(error) }]
  }

  const results: MigrationPreflight[] = []
  for (const ref of refs) {
    const item = await load(ref)
    if (!item) throw new Error(`item_missing: ${ref.kind} ${ref.id} is not on this machine`)
    const base = {
      item: ref,
      label: item.label,
      localStatus: item.localStatus,
      checkedAt,
    }
    const blockers: MigrationBlocker[] = [...shared]
    if (isOwnedElsewhere(item.owner)) {
      blockers.push({ kind: "already-moved", hostLabel: item.owner.hostLabel })
    }
    if (shared.length > 0 || isOwnedElsewhere(item.owner)) {
      // Nothing more is worth asking a host that cannot take the item.
      results.push({ ...base, ready: false, blockers, notes: [], plugins: [] })
      continue
    }
    try {
      const checks = await checkItem(item, facts, platform, await isResumingMove(ref))
      blockers.push(...checks.blockers)
      results.push({
        ...base,
        ready: blockers.length === 0,
        blockers,
        notes: checks.notes,
        plugins: checks.plugins,
      })
    } catch (error) {
      blockers.push({ kind: "host-unreachable", detail: message(error) })
      results.push({ ...base, ready: false, blockers, notes: [], plugins: [] })
    }
  }
  return resolveBatchDependencies(results)
}

/**
 * Drop a `depends-on` whose dependency moves in the same batch, ahead of it,
 * and is itself ready. A dependency that is not ready keeps the dependant
 * waiting, so a Bot is never moved onto a host without its connector.
 */
export function resolveBatchDependencies(
  preflights: readonly MigrationPreflight[]
): MigrationPreflight[] {
  const ready = new Set(
    preflights
      .filter((preflight) => preflight.ready)
      .map((preflight) => `${preflight.item.kind}:${preflight.item.id}`)
  )
  return preflights.map((preflight) => {
    const blockers = preflight.blockers.filter(
      (blocker) =>
        blocker.kind !== "depends-on" || !ready.has(`${blocker.item.kind}:${blocker.item.id}`)
    )
    return blockers.length === preflight.blockers.length
      ? preflight
      : { ...preflight, blockers, ready: blockers.length === 0 }
  })
}
