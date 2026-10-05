/**
 * One sync round: verify the list, hold the current key, replay what was
 * parked, push the outbox, pull and apply until caught up. The engine runs a
 * round whenever something may have changed (a local write, a socket notice,
 * a long-poll answer); tests run rounds directly.
 *
 * Push errors the round can fix itself, it fixes once: a sequence gap means
 * this device lost track of its own sequence (the cursor moves to what the
 * server expects; anything re-sent merges idempotently), a stale epoch means
 * another device rotated (the list and key are refreshed). A removal or an
 * integrity failure is the caller's to handle.
 */

import type { FoldedRegistry } from "@cognia/sync-protocol"

import type { DeviceKeys, EpochKeyChain } from "@/lib/account-sync/crypto"
import { currentKeyChain, verifyRegistry } from "@/lib/account-sync/registry-sync"
import { SyncApiError, type SyncApi } from "@/lib/account-sync/sync-api"
import type { AccountSyncVault } from "@/lib/account-sync/vault-store"
import type { CogniaDB } from "@/lib/db/schema"

import { applyBatches, replayInbox, type ApplyDeps } from "./applier"
import { createOpOriginChecker, type OpOriginChecker } from "./op-origin"
import { pushOutbox, storeDeviceSeq } from "./pusher"
import type { AccountSyncCursorState, SyncedTableName } from "./types"

export class SyncDeviceRemovedError extends Error {
  constructor() {
    super("this device was removed from sync")
    this.name = "SyncDeviceRemovedError"
  }
}

export interface SyncRoundContext {
  db: CogniaDB
  api: SyncApi
  vault: AccountSyncVault
  spaceId: string
  now: () => number
}

export interface SyncRoundOptions {
  /** Let the first pull wait up to this long for new ops (long-poll mode). */
  waitS?: number
  /** Skip pushing (a round started only to pull). */
  pullOnly?: boolean
  /**
   * Only push: no replay, no pull. The engine runs pushes and pulls in two
   * lanes so a change goes up while a long-poll pull is still waiting.
   */
  pushOnly?: boolean
}

export interface SyncRoundResult {
  pushed: number
  applied: number
  parked: number
  tables: Set<SyncedTableName>
  epoch: number
  tooLarge: string[]
  /** The list's head after the round, for the caller's next comparison. */
  registryHead: { seq: number; hash: string }
}

interface Keys {
  registry: FoldedRegistry
  chain: EpochKeyChain
  origin: OpOriginChecker
}

async function keysFor(ctx: SyncRoundContext, device: DeviceKeys): Promise<Keys> {
  const registry = await verifyRegistry(ctx.api, ctx.vault)
  if (!registry) throw new SyncApiError("space_empty", 409, "this account has no sync devices yet")
  if (registry.state.devices[device.deviceId]?.status !== "active")
    throw new SyncDeviceRemovedError()
  return {
    registry,
    chain: await currentKeyChain(ctx.api, ctx.vault, registry.state, device),
    origin: createOpOriginChecker(registry),
  }
}

async function cursorOf(ctx: SyncRoundContext): Promise<AccountSyncCursorState> {
  const stored = (await ctx.db.accountSyncState.get("cursor")) as AccountSyncCursorState | undefined
  return stored?.spaceId === ctx.spaceId
    ? stored
    : { id: "cursor", spaceId: ctx.spaceId, serverSeq: 0, deviceSeq: 0 }
}

export async function runSyncRound(
  ctx: SyncRoundContext,
  device: DeviceKeys,
  options: SyncRoundOptions = {}
): Promise<SyncRoundResult> {
  let keys = await keysFor(ctx, device)
  const applyDeps = (): ApplyDeps => ({
    db: ctx.db,
    spaceId: ctx.spaceId,
    deviceId: device.deviceId,
    registry: keys.registry,
    chain: keys.chain,
    origin: keys.origin,
    now: ctx.now,
  })
  const result: SyncRoundResult = {
    pushed: 0,
    applied: 0,
    parked: 0,
    tables: new Set(),
    epoch: keys.registry.state.epoch,
    tooLarge: [],
    registryHead: keys.registry.state.head,
  }
  const absorb = (applied: { applied: number; parked: number; tables: Set<SyncedTableName> }) => {
    result.applied += applied.applied
    result.parked += applied.parked
    for (const table of applied.tables) result.tables.add(table)
  }

  if (!options.pushOnly) absorb(await replayInbox(applyDeps()))

  if (!options.pullOnly) {
    for (let attempt = 0; ; attempt++) {
      try {
        const pushed = await pushOutbox({
          db: ctx.db,
          spaceId: ctx.spaceId,
          device,
          chain: keys.chain,
          epoch: keys.registry.state.epoch,
          push: (ops) => ctx.api.pushOps(device, ops),
        })
        result.pushed += pushed.pushed
        result.tooLarge.push(...pushed.tooLarge)
        break
      } catch (error) {
        if (!(error instanceof SyncApiError) || attempt > 0) throw error
        if (error.code === "seq_gap" && typeof error.details.expected === "number") {
          await storeDeviceSeq(ctx.db, ctx.spaceId, error.details.expected - 1)
        } else if (error.code === "epoch_stale") {
          keys = await keysFor(ctx, device)
          if (!options.pushOnly) absorb(await replayInbox(applyDeps()))
        } else if (error.code === "device_revoked") {
          throw new SyncDeviceRemovedError()
        } else {
          throw error
        }
      }
    }
  }

  let waitS = options.waitS ?? 0
  for (;;) {
    if (options.pushOnly) break
    const cursor = await cursorOf(ctx)
    let view
    try {
      view = await ctx.api.pullOps(device, cursor.serverSeq, waitS)
    } catch (error) {
      if (error instanceof SyncApiError && error.code === "device_revoked")
        throw new SyncDeviceRemovedError()
      throw error
    }
    waitS = 0
    if (view.registryHead && view.registryHead.hash !== keys.registry.state.head.hash) {
      keys = await keysFor(ctx, device)
      absorb(await replayInbox(applyDeps()))
    }
    absorb(await applyBatches(applyDeps(), view.batches))
    if (!view.more || view.batches.length === 0) break
  }
  result.epoch = keys.registry.state.epoch
  result.registryHead = keys.registry.state.head
  return result
}
