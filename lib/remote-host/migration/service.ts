/**
 * Moving always-on work to a paired host and taking it back (ADR-0224 §Moving
 * an item is a handoff, not a copy).
 *
 * Preflight, transfer, confirm, fence: each move is one journal row
 * (`itemMigrations`) whose operation id is minted before anything is sent and
 * carried by every host call, so an interrupted move resumes where it
 * stopped and a resent call finds what the first one created. The steps and
 * their order live in `items.ts`; this module runs them, records each, and
 * never runs a step whose precondition is not already recorded.
 *
 * Everything goes over the management channel, so the app's own routing is
 * never touched, and every write that needs one carries a single admin lease
 * the user approved for this batch (`requestMigrationLease`).
 */

import {
  advanceItemMigration,
  getItemMigration,
  latestItemMigration,
  putItemMigration,
  type ItemMigrationRow,
  type ItemMigrationState,
} from "@/lib/db/item-migrations"
import { suggestDeviceName } from "@/lib/account-sync/enrollment/platform"
import { isOwnedElsewhere } from "@/lib/placement/ownership"
import {
  ALWAYS_ON_PLUGIN_TRANSFER_HOST_OPERATIONS,
  CODE_SUPPLY_HOST_OPERATIONS,
} from "@/lib/platform/host-feature-manifest"
import {
  withManagementChannel,
  type ManagementChannelDeps,
  type ManagementChannelLease,
} from "@/lib/remote-host/management-channel"
import { issueHostAdminLease, type HostAdminLease } from "@/lib/tauri/admin-lease"
import type { ItemOwnerRemoteHost } from "@/types/placement/item-owner"

import { readHostFacts, type HostFacts } from "./host-facts"
import {
  armCompanionOnHost,
  armOnHost,
  companionsOf,
  createCompanionOnHost,
  createOnHost,
  loadItem,
  remoteItemIdFor,
  remoteStatus,
  removeCompanionFromHost,
  removeFromHost,
  setCompanionOwner,
  setLocalOwner,
  type LoadedItem,
  type TransferContext,
} from "./items"
import { preflightItems, sortForMigration } from "./preflight"
import type { MigrationItemRef, MigrationOutcome, MigrationPreflight } from "./types"

/**
 * The interactive host commands a move or take-back calls, plugin transfer
 * included. One lease covers a batch.
 */
export const MIGRATION_LEASE_OPERATIONS = [
  "scheduled_task_import",
  "scheduled_task_delete",
  "adapter_instance_mutate",
  "connectors_keyring_set",
  // Interactive since ADR-0224 A6: a Bot's install, arm and take-back.
  "bot_installation_mutate",
  ...ALWAYS_ON_PLUGIN_TRANSFER_HOST_OPERATIONS,
  // A workspace an item is bound to (ADR-0224 A11).
  ...CODE_SUPPLY_HOST_OPERATIONS,
] as const

/** Long enough for a batch over a slow relay; short enough to be worth asking for. */
export const MIGRATION_LEASE_TTL_SECONDS = 15 * 60

export interface MigrationServiceDeps {
  channel?: ManagementChannelDeps
  facts?: (lease: ManagementChannelLease) => HostFacts
  load?: (ref: MigrationItemRef) => Promise<LoadedItem | undefined>
  now?: () => number
  newOperationId?: () => string
  /** How this device names itself to the host. */
  sourceLabel?: () => string
}

function withChannel<T>(
  hostId: string,
  deps: MigrationServiceDeps,
  work: (lease: ManagementChannelLease) => Promise<T>
): Promise<T> {
  return withManagementChannel(hostId, work, deps.channel)
}

function factsFor(lease: ManagementChannelLease, deps: MigrationServiceDeps): HostFacts {
  return deps.facts ? deps.facts(lease) : readHostFacts(lease.transport)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sourceLabelOf(deps: MigrationServiceDeps): string {
  return deps.sourceLabel?.() || suggestDeviceName() || "desktop"
}

/** Preflight a batch against a host, over its management channel. */
export function preflightMigration(
  hostId: string,
  refs: readonly MigrationItemRef[],
  deps: MigrationServiceDeps = {}
): Promise<MigrationPreflight[]> {
  return withChannel(hostId, deps, (lease) =>
    preflightItems(refs, factsFor(lease, deps), {
      ...(deps.load ? { load: deps.load } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
  )
}

/**
 * Ask the host for the admin lease a batch needs. Call only from an explicit
 * user action: the host may answer `HostConsentRequiredError` with a code a
 * person approves at the host, and the caller asks again once they have.
 */
export function requestMigrationLease(
  hostId: string,
  deps: MigrationServiceDeps = {}
): Promise<HostAdminLease> {
  return withChannel(hostId, deps, (lease) =>
    issueHostAdminLease(
      [...MIGRATION_LEASE_OPERATIONS],
      MIGRATION_LEASE_TTL_SECONDS,
      lease.transport
    )
  )
}

async function fail(
  row: ItemMigrationRow,
  error: unknown,
  resumeFrom: Exclude<ItemMigrationState, "failed">,
  now: number
): Promise<MigrationOutcome> {
  const failed = await advanceItemMigration(
    row.operationId,
    { state: "failed", resumeFrom, error: message(error) },
    now
  )
  return {
    item: { kind: row.itemKind, id: row.itemId },
    operationId: row.operationId,
    ok: false,
    state: failed.state,
    error: failed.error,
  }
}

/**
 * Run a move from whatever step its journal says is next. Each step is
 * recorded before the next one starts, so a crash between two leaves the
 * journal naming the step to redo, and every step is safe to redo.
 */
async function runMove(
  row: ItemMigrationRow,
  item: LoadedItem,
  context: TransferContext,
  now: () => number
): Promise<MigrationOutcome> {
  let current = row
  let step: Exclude<ItemMigrationState, "failed"> =
    current.state === "failed" ? (current.resumeFrom ?? "prepared") : current.state
  const remoteItemId = current.remoteItemId ?? remoteItemIdFor(item, current.operationId)
  try {
    if (step === "prepared") {
      await createOnHost(item, context)
      for (const companion of current.companions ?? []) {
        await createCompanionOnHost(companion, context)
      }
      current = await advanceItemMigration(
        current.operationId,
        { state: "created", remoteItemId },
        now()
      )
      step = "created"
    }
    if (step === "created") {
      // Confirm before fencing: a placeholder for a host copy that does not
      // exist would leave the item running nowhere.
      if ((await remoteStatus(current.itemKind, remoteItemId, context.transport)) === null) {
        throw new Error("item_not_on_host: the host did not keep the item it was sent")
      }
      const owner: ItemOwnerRemoteHost = {
        kind: "remote-host",
        hostId: current.hostId,
        hostLabel: current.hostLabel,
        remoteItemId,
        operationId: current.operationId,
        movedAt: now(),
      }
      await setLocalOwner(current.itemKind, current.itemId, owner)
      for (const companion of current.companions ?? []) {
        await setCompanionOwner(companion, { ...owner, remoteItemId: companion.id })
      }
      current = await advanceItemMigration(current.operationId, { state: "fenced" }, now())
      step = "fenced"
    }
    if (step === "fenced") {
      await armOnHost(
        { kind: current.itemKind, localStatus: current.localStatus },
        remoteItemId,
        context
      )
      // After the item: a schedule must not fire before the connector it sends through runs.
      for (const companion of current.companions ?? []) {
        await armCompanionOnHost(companion, context)
      }
      current = await advanceItemMigration(current.operationId, { state: "completed" }, now())
    }
    return {
      item: { kind: current.itemKind, id: current.itemId },
      operationId: current.operationId,
      ok: true,
      state: current.state,
    }
  } catch (error) {
    return fail(current, error, step, now())
  }
}

export interface MoveOptions {
  /** From `requestMigrationLease`, approved by the user for this batch. */
  adminLease: string
  /** Called as each item finishes, in batch order. */
  onProgress?: (outcome: MigrationOutcome) => void
}

/**
 * Move a batch to a host. Each item is preflighted again first; one that is
 * no longer ready is not touched and reported as such. Connector instances
 * move before the Bots and tasks that use them.
 */
export async function moveItems(
  hostId: string,
  refs: readonly MigrationItemRef[],
  options: MoveOptions,
  deps: MigrationServiceDeps = {}
): Promise<MigrationOutcome[]> {
  const now = deps.now ?? Date.now
  const newOperationId = deps.newOperationId ?? (() => crypto.randomUUID())
  const load = deps.load ?? loadItem
  return withChannel(hostId, deps, async (lease) => {
    const preflights = await preflightItems(sortForMigration(refs), factsFor(lease, deps), {
      load,
      now,
    })
    const outcomes: MigrationOutcome[] = []
    for (const preflight of preflights) {
      const report = (outcome: MigrationOutcome) => {
        outcomes.push(outcome)
        options.onProgress?.(outcome)
      }
      const item = await load(preflight.item)
      if (!preflight.ready || !item) {
        report({
          item: preflight.item,
          operationId: "",
          ok: false,
          state: "blocked",
          error: preflight.blockers.map((blocker) => blocker.kind).join(", ") || "item_missing",
        })
        continue
      }
      const latest = await latestItemMigration(preflight.item.kind, preflight.item.id)
      const resumable =
        latest?.direction === "move" &&
        latest.hostId === hostId &&
        latest.state !== "completed" &&
        latest.state !== "awaiting-host"
      let row: ItemMigrationRow
      if (resumable) {
        row = latest
      } else {
        const at = now()
        const companions = companionsOf(item)
        row = {
          operationId: newOperationId(),
          direction: "move",
          itemKind: preflight.item.kind,
          itemId: preflight.item.id,
          itemLabel: item.label,
          hostId,
          hostLabel: lease.host.label,
          localStatus: item.localStatus,
          ...(companions.length > 0 ? { companions } : {}),
          state: "prepared",
          history: [{ state: "prepared", at }],
          createdAt: at,
          updatedAt: at,
        }
        await putItemMigration(row)
      }
      report(
        await runMove(
          row,
          item,
          {
            transport: lease.transport,
            adminLease: options.adminLease,
            operationId: row.operationId,
            sourceLabel: sourceLabelOf(deps),
          },
          now
        )
      )
    }
    return outcomes
  })
}

/** Resume one interrupted or failed move from the step its journal names. */
export async function resumeMove(
  operationId: string,
  options: Pick<MoveOptions, "adminLease">,
  deps: MigrationServiceDeps = {}
): Promise<MigrationOutcome> {
  const now = deps.now ?? Date.now
  const row = await getItemMigration(operationId)
  if (!row || row.direction !== "move") throw new Error(`item_migration_missing: ${operationId}`)
  if (row.state === "completed") {
    return { item: { kind: row.itemKind, id: row.itemId }, operationId, ok: true, state: row.state }
  }
  const item = await (deps.load ?? loadItem)({ kind: row.itemKind, id: row.itemId })
  if (!item) throw new Error(`item_missing: ${row.itemKind} ${row.itemId} is not on this machine`)
  return withChannel(row.hostId, deps, (lease) =>
    runMove(
      row,
      item,
      {
        transport: lease.transport,
        adminLease: options.adminLease,
        operationId,
        sourceLabel: sourceLabelOf(deps),
      },
      now
    )
  )
}

export interface TakeBackOptions {
  adminLease?: string
  /**
   * Restore the item here even though its host cannot be reached. Its copy
   * there keeps running until it is removed, so the journal stays
   * `awaiting-host` and the console offers to finish when the host answers.
   */
  evenIfHostUnreachable?: boolean
}

/**
 * Take a moved item back: remove the host's copy, then restore this one with
 * the status the host had for it (so a Bot paused there comes back paused).
 */
export async function takeBackItem(
  ref: MigrationItemRef,
  options: TakeBackOptions,
  deps: MigrationServiceDeps = {}
): Promise<MigrationOutcome> {
  const now = deps.now ?? Date.now
  const item = await (deps.load ?? loadItem)(ref)
  if (!item) throw new Error(`item_missing: ${ref.kind} ${ref.id} is not on this machine`)
  if (!isOwnedElsewhere(item.owner)) {
    throw new Error(`item_not_moved: ${ref.kind} ${ref.id} already runs on this machine`)
  }
  const owner = item.owner
  const move = await latestItemMigration(ref.kind, ref.id)
  const at = now()
  const row: ItemMigrationRow = {
    operationId: (deps.newOperationId ?? (() => crypto.randomUUID()))(),
    direction: "take-back",
    itemKind: ref.kind,
    itemId: ref.id,
    itemLabel: item.label,
    hostId: owner.hostId,
    hostLabel: owner.hostLabel,
    remoteItemId: owner.remoteItemId,
    localStatus: move?.direction === "move" ? move.localStatus : "paused",
    ...(move?.direction === "move" && move.companions ? { companions: move.companions } : {}),
    state: "prepared",
    history: [{ state: "prepared", at }],
    createdAt: at,
    updatedAt: at,
  }
  await putItemMigration(row)
  return finishTakeBack(row, options, deps)
}

/**
 * Restore here with this status and record the take-back's state. Each
 * companion comes back with the host's status for it, or its own from before
 * the move when the host could not say.
 */
async function restoreHere(
  row: ItemMigrationRow,
  status: string,
  state: "completed" | "awaiting-host",
  now: number,
  detail?: string,
  companionStatus: ReadonlyMap<string, string> = new Map()
): Promise<MigrationOutcome> {
  await setLocalOwner(row.itemKind, row.itemId, undefined, status)
  for (const companion of row.companions ?? []) {
    await setCompanionOwner(
      companion,
      undefined,
      companionStatus.get(companion.id) ?? companion.localStatus
    )
  }
  const done = await advanceItemMigration(
    row.operationId,
    { state, ...(detail ? { detail } : {}) },
    now
  )
  return {
    item: { kind: row.itemKind, id: row.itemId },
    operationId: row.operationId,
    ok: true,
    state: done.state,
  }
}

async function finishTakeBack(
  row: ItemMigrationRow,
  options: TakeBackOptions,
  deps: MigrationServiceDeps
): Promise<MigrationOutcome> {
  const now = deps.now ?? Date.now
  const remoteItemId = row.remoteItemId ?? row.itemId
  try {
    return await withChannel(row.hostId, deps, async (lease) => {
      if (!options.adminLease)
        throw new Error("admin_lease_required: approve the take-back on the host")
      const context = {
        transport: lease.transport,
        adminLease: options.adminLease,
        operationId: row.operationId,
      }
      // Companions first: a schedule must not fire on the host after the
      // connector it sends through is gone.
      const companionStatus = new Map<string, string>()
      for (const companion of row.companions ?? []) {
        const hostStatus = await removeCompanionFromHost(companion, context)
        if (hostStatus !== null) companionStatus.set(companion.id, hostStatus)
      }
      const status = await remoteStatus(row.itemKind, remoteItemId, lease.transport)
      if (status !== null) await removeFromHost(row.itemKind, remoteItemId, context)
      return restoreHere(
        row,
        status ?? row.localStatus,
        "completed",
        now(),
        undefined,
        companionStatus
      )
    })
  } catch (error) {
    if (!options.evenIfHostUnreachable) return fail(row, error, "prepared", now())
    return restoreHere(row, row.localStatus, "awaiting-host", now(), message(error))
  }
}

/**
 * Remove the host's copy of an item taken back while its host was offline.
 * The item already runs here; this only finishes the host's side.
 */
export async function finishPendingTakeBack(
  operationId: string,
  options: { adminLease: string },
  deps: MigrationServiceDeps = {}
): Promise<MigrationOutcome> {
  const now = deps.now ?? Date.now
  const row = await getItemMigration(operationId)
  if (!row || row.direction !== "take-back") {
    throw new Error(`item_migration_missing: ${operationId}`)
  }
  if (row.state === "completed") {
    return { item: { kind: row.itemKind, id: row.itemId }, operationId, ok: true, state: row.state }
  }
  const remoteItemId = row.remoteItemId ?? row.itemId
  return withChannel(row.hostId, deps, async (lease) => {
    const context = { transport: lease.transport, adminLease: options.adminLease, operationId }
    for (const companion of row.companions ?? []) await removeCompanionFromHost(companion, context)
    if ((await remoteStatus(row.itemKind, remoteItemId, lease.transport)) !== null) {
      await removeFromHost(row.itemKind, remoteItemId, context)
    }
    const done = await advanceItemMigration(operationId, { state: "completed" }, now())
    return {
      item: { kind: row.itemKind, id: row.itemId },
      operationId,
      ok: true,
      state: done.state,
    }
  })
}
