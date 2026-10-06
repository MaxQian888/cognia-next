/** Devices of one person syncing data through the in-memory server (tests only, not shipped). */

import "fake-indexeddb/auto"

import {
  encryptOpPayload,
  opKey,
  signOp,
  type FoldedRegistry,
  type Op,
  type OpHeader,
  type OpPayload,
} from "@cognia/sync-protocol"

import { AccountContentCipher, activateAccountContentCipher } from "@/lib/accounts/content-cipher"
import { CogniaDB } from "@/lib/db/schema"

import type { DeviceKeys, EpochKeyChain } from "../crypto"
import { currentKeyChain, verifyRegistry } from "../registry-sync"
import type { AccountSyncContext } from "../enrollment/context"
import { recoverWithKey } from "../enrollment/recover"
import { TEST_SPACE, identity, spaceWithFirstDevice, testContext } from "../enrollment/test-support"
import type { FakeSyncServer } from "../testing/fake-sync-server"
import { createFakeSyncServer } from "../testing/fake-sync-server"
import { runSyncRound, type SyncRoundOptions, type SyncRoundResult } from "./sync-round"
import type { AccountSyncCaptureState } from "./types"

export interface SyncDevice {
  name: string
  db: CogniaDB
  context: AccountSyncContext
  keys(): Promise<DeviceKeys>
  round(options?: SyncRoundOptions): Promise<SyncRoundResult>
}

let databases = 0

/** Arms `db`'s capture for `device` (what enrollment does in the engine). */
export async function armCapture(db: CogniaDB, deviceId: string): Promise<void> {
  const state: AccountSyncCaptureState = {
    id: "capture",
    spaceId: TEST_SPACE,
    deviceId,
    classes: { content: true, settings: true },
    hlc: null,
  }
  await db.accountSyncState.put(state)
}

async function deviceFrom(
  name: string,
  context: AccountSyncContext,
  encrypted = false
): Promise<SyncDevice> {
  const index = ++databases
  // An account database (`cognia-account-…`) gets the content-encryption
  // middleware, as in the app; the process holds one active cipher.
  const dbName = encrypted
    ? `cognia-account-acct_sync_${index}-encrypted-v1`
    : `account-sync-data-${name}-${index}`
  if (encrypted) {
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(`acct_sync_${index}`, dbName)
    )
  }
  const db = new CogniaDB(dbName, "account-sync-test")
  await db.open()
  const keys = async () => {
    const found = await context.vault.loadDeviceKeys()
    if (!found) throw new Error(`${name} has no keys`)
    return found
  }
  await armCapture(db, (await keys()).deviceId)
  return {
    name,
    db,
    context,
    keys,
    round: async (options) =>
      runSyncRound(
        { db, api: context.api, vault: context.vault, spaceId: TEST_SPACE, now: context.now },
        await keys(),
        options
      ),
  }
}

/**
 * A space with `names.length` enrolled devices: the first creates it, the rest
 * recover into it. `encrypted` names the one device whose database encrypts
 * its content at rest, as an app profile's does.
 */
export async function syncedDevices(
  names: readonly string[],
  server: FakeSyncServer = createFakeSyncServer({ spaceId: TEST_SPACE }),
  options: { encrypted?: string } = {}
): Promise<{ server: FakeSyncServer; devices: SyncDevice[]; recoveryKeyText: string }> {
  const [firstName, ...rest] = names
  const first = await spaceWithFirstDevice(server, firstName)
  const devices = [await deviceFrom(firstName!, first.context, options.encrypted === firstName)]
  for (const name of rest) {
    const context = testContext(server, name)
    await recoverWithKey(context, first.recoveryKeyText, identity(name))
    devices.push(await deviceFrom(name, context, options.encrypted === name))
  }
  return { server, devices, recoveryKeyText: first.recoveryKeyText }
}

/** Rounds on every device until nothing moves (at most `limit` sweeps). */
export async function settleAll(devices: readonly SyncDevice[], limit = 5): Promise<void> {
  for (let sweep = 0; sweep < limit; sweep++) {
    let moved = 0
    for (const device of devices) {
      const result = await device.round()
      moved += result.pushed + result.applied
    }
    if (moved === 0) return
  }
  throw new Error("devices did not settle")
}

/** What a device verified: its keys, the device list, and the epoch keys it holds. */
export async function verifiedKeys(
  device: SyncDevice
): Promise<{ keys: DeviceKeys; registry: FoldedRegistry; chain: EpochKeyChain }> {
  const keys = await device.keys()
  const registry = await verifyRegistry(device.context.api, device.context.vault)
  if (!registry) throw new Error("the space is empty")
  const chain = await currentKeyChain(
    device.context.api,
    device.context.vault,
    registry.state,
    keys
  )
  return { keys, registry, chain }
}

/**
 * An op `device` signs, sealed under its current epoch key whatever epoch the
 * header claims (tests build both honest ops and forgeries with it).
 */
export async function sealedOp(
  device: SyncDevice,
  payload: OpPayload,
  header: Partial<OpHeader> = {}
): Promise<Op> {
  const { keys, registry, chain } = await verifiedKeys(device)
  const full: OpHeader = {
    deviceId: keys.deviceId,
    deviceSeq: 1,
    hlc: { ms: 1_000, c: 0 },
    epoch: registry.state.epoch,
    schemaVer: 1,
    cls: "c",
    ...header,
  }
  const key = await opKey(chain.get(registry.state.epoch)!, TEST_SPACE)
  const { nonce, ct } = await encryptOpPayload(key, TEST_SPACE, full, payload)
  return signOp(keys.sign.privateKey, TEST_SPACE, { ...full, nonce, ct })
}

export function closeAll(devices: readonly SyncDevice[]): void {
  for (const device of devices) device.db.close()
}
