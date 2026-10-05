/**
 * The device registry (protocol §4): an append-only hash chain of signed
 * entries. Public keys and binary values are base64url (raw P-256 points are
 * 65 bytes).
 */

export type DevicePlatform = "desktop" | "mobile" | "web"

/** Reserved for a later phase; phase 2 refuses it (no vault on a headless host). */
export const RESERVED_PLATFORMS = ["headless"] as const

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["desktop", "mobile", "web"]

/** A display name, sealed under the `name` subkey of `epoch` (§3.3). */
export interface NameCiphertext {
  epoch: number
  nonce: string
  ct: string
}

export interface DeviceDescriptor {
  deviceId: string
  platform: DevicePlatform
  signPub: string
  encPub: string
  nameCt: NameCiphertext
}

export interface RecoveryKeys {
  signPub: string
  encPub: string
}

export interface PrevWrap {
  nonce: string
  ct: string
}

/** Starts an epoch: its key commitment and the wrap of the previous key. */
export interface EpochBlock {
  epoch: number
  keyCommit: string
  prevWrap?: PrevWrap
}

interface EntryBase {
  v: 1
  spaceId: string
  seq: number
  /** `entryHash` of the previous entry; null for genesis. */
  prev: string | null
  /** Client time in ms; display only, never trusted for ordering. */
  at: number
}

export interface GenesisEntry extends EntryBase {
  type: "genesis"
  device: DeviceDescriptor
  recovery: RecoveryKeys
  epoch: EpochBlock
}

export interface AddDeviceByApprovalEntry extends EntryBase {
  type: "add-device"
  via: "approval"
  device: DeviceDescriptor
  requestId: string
  transcriptHash: string
}

export interface AddDeviceByRecoveryEntry extends EntryBase {
  type: "add-device"
  via: "recovery"
  device: DeviceDescriptor
}

export interface RevokeDeviceEntry extends EntryBase {
  type: "revoke-device"
  deviceId: string
  epoch: EpochBlock
}

export interface RecoveryRotateEntry extends EntryBase {
  type: "recovery-rotate"
  recovery: RecoveryKeys
  epoch: EpochBlock
}

export interface EpochRotateEntry extends EntryBase {
  type: "epoch-rotate"
  epoch: EpochBlock
}

export type RegistryEntry =
  | GenesisEntry
  | AddDeviceByApprovalEntry
  | AddDeviceByRecoveryEntry
  | RevokeDeviceEntry
  | RecoveryRotateEntry
  | EpochRotateEntry

export type EntrySigner = string // a deviceId, or RECOVERY_SIGNER

export const RECOVERY_SIGNER = "recovery"

export interface EntrySignature {
  signer: EntrySigner
  sig: string
}

/** One registry element as stored and sent. */
export interface SignedEntry {
  entry: RegistryEntry
  sigs: EntrySignature[]
}

export type DeviceStatus = "active" | "revoked"

export interface RegistryDevice extends DeviceDescriptor {
  status: DeviceStatus
  addedSeq: number
  addedVia: "genesis" | "approval" | "recovery"
  addedBy: EntrySigner | null
  revokedSeq: number | null
  revokedBy: string | null
}

/** What every verifier derives from a valid chain. */
export interface RegistryState {
  spaceId: string
  genesisHash: string
  head: { seq: number; hash: string }
  epoch: number
  /** Key commitment of every epoch, by epoch number. */
  keyCommits: Record<number, string>
  /** `prevWrap` of every epoch above 1, by epoch number. */
  prevWraps: Record<number, PrevWrap>
  recovery: RecoveryKeys
  devices: Record<string, RegistryDevice>
  /** Every public key ever registered (devices and recovery); never reused. */
  usedKeys: string[]
  /**
   * Set right after an `add-device` via recovery: the next entry must be an
   * `epoch-rotate` signed by that device (the same atomic batch).
   */
  pendingRecoveryRotate: string | null
}

export interface HashedEntry {
  signed: SignedEntry
  hash: string
}
