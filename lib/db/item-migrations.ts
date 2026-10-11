/**
 * The journal of always-on work moved to, or taken back from, a paired host
 * (ADR-0224). Table `itemMigrations` (v238).
 *
 * A move crosses two machines and several calls, any of which can fail or be
 * interrupted by a closed laptop. The journal is what makes it resumable and
 * idempotent: the operation id is minted once, here, before anything is sent,
 * and every host call carries it, so a resumed move finds what the host
 * already created instead of creating a second copy. It is also the record
 * the guided flow's result view and the device console read.
 *
 * One row per operation. A move and the take-back that reverses it are two
 * rows, so the history of an item reads in order.
 */

import { getDb } from "./schema"
import type { OwnedItemKind } from "@/types/placement/item-owner"

export type ItemMigrationDirection = "move" | "take-back"

/**
 * Where an operation stands. Each state names what is already true, so a
 * resumed operation continues from the step after it:
 *
 *   * `prepared`: the operation id exists; nothing reached the host.
 *   * `created`: the host holds the item, not yet running (move only).
 *   * `fenced`: this machine's copy is a disabled placeholder (move), or has
 *     been restored and runs here again (take-back).
 *   * `completed`: the host runs it (move), or no longer holds it (take-back).
 *   * `awaiting-host`: a take-back done here while the host was unreachable;
 *     its copy is removed the next time the host answers.
 *   * `failed`: stopped on `error`, resumable from `resumeFrom`.
 */
export type ItemMigrationState =
  "prepared" | "created" | "fenced" | "completed" | "awaiting-host" | "failed"

export interface ItemMigrationHistoryEntry {
  state: ItemMigrationState
  at: number
  detail?: string
}

/**
 * Something that belongs to the item and moves with it, frozen when the
 * operation starts: today the scheduled messages set up in a connector's
 * chats (`connection:scheduled:digest`). Each keeps its id on the host.
 */
export interface ItemMigrationCompanion {
  kind: "scheduled-task"
  id: string
  label: string
  /** Its status here before the move, which a take-back restores when the host cannot say. */
  localStatus: string
}

export interface ItemMigrationRow {
  operationId: string
  direction: ItemMigrationDirection
  itemKind: OwnedItemKind
  /** The item's id on this machine. */
  itemId: string
  /** Its name when the operation started, for the journal and the result view. */
  itemLabel: string
  /** `RemoteHost.id` in this device's registry. */
  hostId: string
  hostLabel: string
  /** The item's id on the host, once known. */
  remoteItemId?: string
  /**
   * The local status before a move (`active`, `enabled`, …), restored by a
   * take-back that cannot read the host's.
   */
  localStatus: string
  /** What moves with the item; absent when nothing does. */
  companions?: ItemMigrationCompanion[]
  state: ItemMigrationState
  /** The state a `failed` operation resumes from. */
  resumeFrom?: Exclude<ItemMigrationState, "failed">
  error?: string
  history: ItemMigrationHistoryEntry[]
  createdAt: number
  updatedAt: number
}

export async function putItemMigration(row: ItemMigrationRow): Promise<void> {
  await getDb().itemMigrations.put(row)
}

export async function getItemMigration(operationId: string): Promise<ItemMigrationRow | undefined> {
  return getDb().itemMigrations.get(operationId)
}

/**
 * Advance one operation and append the step to its history, in one
 * transaction so two tabs resuming the same operation cannot both record it.
 */
export async function advanceItemMigration(
  operationId: string,
  patch: Partial<Pick<ItemMigrationRow, "remoteItemId" | "error" | "resumeFrom">> & {
    state: ItemMigrationState
    detail?: string
  },
  now: number = Date.now()
): Promise<ItemMigrationRow> {
  const db = getDb()
  return db.transaction("rw", db.itemMigrations, async () => {
    const current = await db.itemMigrations.get(operationId)
    if (!current) throw new Error(`item_migration_missing: ${operationId}`)
    const { detail, ...fields } = patch
    const next: ItemMigrationRow = {
      ...current,
      ...fields,
      updatedAt: now,
      history: [...current.history, { state: patch.state, at: now, ...(detail ? { detail } : {}) }],
    }
    if (patch.state !== "failed") {
      delete next.error
      delete next.resumeFrom
    }
    await db.itemMigrations.put(next)
    return next
  })
}

/** Every operation on one item, oldest first. */
export async function listItemMigrations(
  itemKind: OwnedItemKind,
  itemId: string
): Promise<ItemMigrationRow[]> {
  const rows = await getDb()
    .itemMigrations.where("[itemKind+itemId]")
    .equals([itemKind, itemId])
    .toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** The latest operation on one item, if any. */
export async function latestItemMigration(
  itemKind: OwnedItemKind,
  itemId: string
): Promise<ItemMigrationRow | undefined> {
  return (await listItemMigrations(itemKind, itemId)).at(-1)
}

/** Operations that stopped short of done: interrupted, failed, or waiting on a host. */
export async function listUnfinishedItemMigrations(): Promise<ItemMigrationRow[]> {
  const rows = await getDb()
    .itemMigrations.where("state")
    .anyOf(["prepared", "created", "fenced", "failed", "awaiting-host"])
    .toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** Recent operations for one host, newest first. */
export async function listHostItemMigrations(hostId: string): Promise<ItemMigrationRow[]> {
  const rows = await getDb().itemMigrations.where("hostId").equals(hostId).toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}
