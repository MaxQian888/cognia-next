/**
 * Where a device keeps its account sync secrets (protocol §3, §4.1): its
 * device keys, the epoch key chain, the rollback pin, and the record of being
 * removed. They live in the profile's secret store (`createKeyringStore`):
 * the OS keyring on the desktop, the Keychain / Keystore on a phone, the
 * encrypted Browser Vault on the web. Each is scoped to the local profile
 * AND the space, so two profiles never share a device identity.
 *
 * Nothing is written while values would not survive a restart (a locked
 * Browser Vault): a device that forgot its keys would have to enroll again.
 * Imported keys are cached in memory against the stored value, so another tab
 * forgetting the device is seen at once, and dropped as soon as the store
 * reports it is no longer persistent (the vault locked).
 */

import type { RegistryPin } from "@cognia/sync-protocol"
import { laterPin } from "@cognia/sync-protocol"

import {
  importDeviceKeys,
  parseDeviceKeyMaterial,
  parseKeyChain,
  serializeKeyChain,
  type DeviceKeyMaterial,
  type DeviceKeys,
  type EpochKeyChain,
} from "@/lib/account-sync/crypto"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

export const ACCOUNT_SYNC_SECRET_NAMESPACE = "account-sync/v1"

export class AccountSyncVaultLockedError extends Error {
  readonly code = "vault_locked"
  constructor() {
    super("unlock this profile before using account sync")
    this.name = "AccountSyncVaultLockedError"
  }
}

/** Why and when this device stopped being part of the space (kept after its keys are gone). */
export interface RemovalRecord {
  at: number
  /** The revoke entry's sequence number. */
  seq: number
  /** The device that removed this one. */
  by: string
}

export interface AccountSyncVaultScope {
  localAccountId: string
  spaceId: string
}

export interface AccountSyncVault {
  readonly scope: AccountSyncVaultScope
  /** Throws when secrets would not survive a restart. */
  assertAvailable(): void
  loadDeviceKeys(): Promise<DeviceKeys | null>
  /** Stores this device's keys; a removal record from an earlier enrollment is cleared. */
  saveDeviceKeys(material: DeviceKeyMaterial): Promise<DeviceKeys>
  loadKeyChain(): Promise<EpochKeyChain | null>
  saveKeyChain(chain: EpochKeyChain): Promise<void>
  loadPin(): Promise<RegistryPin | null>
  /** Moves the pin forward only. */
  advancePin(pin: RegistryPin): Promise<RegistryPin>
  loadRemoval(): Promise<RemovalRecord | null>
  /** Deletes the device keys and key chain, keeps the pin, records the removal. */
  forgetDevice(removal: RemovalRecord): Promise<void>
}

const memory = new Map<string, { raw: string; keys: DeviceKeys }>()

/** Test seam. */
export function __clearAccountSyncKeyCache(): void {
  memory.clear()
}

function parsePin(raw: string | null): RegistryPin | null {
  if (!raw) return null
  const value = JSON.parse(raw) as Partial<RegistryPin>
  if (
    typeof value.genesisHash !== "string" ||
    typeof value.hash !== "string" ||
    !Number.isSafeInteger(value.seq) ||
    !Number.isSafeInteger(value.epoch)
  ) {
    throw new Error("the stored registry pin is not readable")
  }
  return value as RegistryPin
}

export function createAccountSyncVault(
  scope: AccountSyncVaultScope,
  store: KeyringStore = createKeyringStore(ACCOUNT_SYNC_SECRET_NAMESPACE)
): AccountSyncVault {
  const key = (name: string) => `${scope.localAccountId}:${scope.spaceId}:${name}`
  const cacheKey = key("device")

  function assertAvailable(): void {
    if (store.isPersistent?.() === false) {
      memory.delete(cacheKey)
      throw new AccountSyncVaultLockedError()
    }
  }

  return {
    scope,
    assertAvailable,

    async loadDeviceKeys() {
      assertAvailable()
      const raw = await store.load(key("device"))
      if (!raw) {
        memory.delete(cacheKey)
        return null
      }
      const cached = memory.get(cacheKey)
      if (cached?.raw === raw) return cached.keys
      const keys = await importDeviceKeys(parseDeviceKeyMaterial(JSON.parse(raw)))
      memory.set(cacheKey, { raw, keys })
      return keys
    },

    async saveDeviceKeys(material) {
      assertAvailable()
      const keys = await importDeviceKeys(material)
      const raw = JSON.stringify(material)
      await store.save(key("device"), raw)
      await store.delete(key("removed"))
      memory.set(cacheKey, { raw, keys })
      return keys
    },

    async loadKeyChain() {
      assertAvailable()
      const raw = await store.load(key("chain"))
      return raw ? parseKeyChain(raw) : null
    },

    async saveKeyChain(chain) {
      assertAvailable()
      await store.save(key("chain"), serializeKeyChain(chain))
    },

    async loadPin() {
      assertAvailable()
      return parsePin(await store.load(key("pin")))
    },

    async advancePin(pin) {
      assertAvailable()
      const next = laterPin(parsePin(await store.load(key("pin"))), pin)
      await store.save(key("pin"), JSON.stringify(next))
      return next
    },

    async loadRemoval() {
      assertAvailable()
      const raw = await store.load(key("removed"))
      return raw ? (JSON.parse(raw) as RemovalRecord) : null
    },

    async forgetDevice(removal) {
      assertAvailable()
      await store.save(key("removed"), JSON.stringify(removal))
      await store.delete(key("device"))
      await store.delete(key("chain"))
      memory.delete(cacheKey)
    },
  }
}
