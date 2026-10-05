/**
 * `validateAppend` (protocol §4): the one rule set the sync Worker and every
 * client apply to each registry entry. The Worker uses it to refuse an
 * invalid append; a client uses it, through `foldRegistry`, to refuse a chain
 * the server could have forged.
 *
 * Parsing is strict on purpose: unknown fields, wrong lengths and
 * non-canonical encodings are refused rather than ignored, because whatever
 * passes here is what gets hashed and signed.
 */

import { fromBase64Url, fromBase64UrlExact } from "../bytes"
import { assertEcdhPublicKey, ecdsaVerify, importEcdsaPublicKey } from "../crypto"
import { RegistryError } from "../errors"
import { isDeviceId, isRequestId } from "../ids"
import { canonicalJsonBytes } from "../jcs"
import { MAX_ACTIVE_DEVICES, MAX_ENTRY_BYTES } from "../limits"
import { entryHash, entrySigningBytes } from "./encode"
import {
  DEVICE_PLATFORMS,
  RECOVERY_SIGNER,
  type DeviceDescriptor,
  type DevicePlatform,
  type EntrySignature,
  type EpochBlock,
  type NameCiphertext,
  type RecoveryKeys,
  type RegistryDevice,
  type RegistryEntry,
  type RegistryState,
  type SignedEntry,
} from "./types"

/** A sealed display name: 1 length byte + up to 63 name bytes, padded to 64, plus the GCM tag. */
export const NAME_CIPHERTEXT_BYTES = 64 + 16
const NONCE_BYTES = 12
const HASH_BYTES = 32
/** AES-256-GCM of a 32-byte key. */
const PREV_WRAP_BYTES = 32 + 16

function malformed(message: string): never {
  throw new RegistryError("malformed", message)
}

function rule(message: string): never {
  throw new RegistryError("rule", message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) malformed(`${what} has an unknown field ${key}`)
  }
}

function integer(value: unknown, what: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    malformed(`${what} must be an integer ≥ ${min}`)
  }
  return value
}

function exactBytes(value: unknown, length: number, what: string): string {
  try {
    fromBase64UrlExact(value, length, what)
  } catch (error) {
    malformed(error instanceof Error ? error.message : `${what} is invalid`)
  }
  return value as string
}

async function signingPoint(value: unknown, what: string): Promise<string> {
  const text = exactBytes(value, 65, what)
  try {
    await importEcdsaPublicKey(fromBase64Url(text))
  } catch {
    malformed(`${what} is not a P-256 point`)
  }
  return text
}

async function encryptionPoint(value: unknown, what: string): Promise<string> {
  const text = exactBytes(value, 65, what)
  try {
    await assertEcdhPublicKey(fromBase64Url(text))
  } catch {
    malformed(`${what} is not a P-256 point`)
  }
  return text
}

function parseNameCt(value: unknown): NameCiphertext {
  if (!isRecord(value)) malformed("nameCt must be an object")
  onlyKeys(value, ["epoch", "nonce", "ct"], "nameCt")
  return {
    epoch: integer(value.epoch, "nameCt.epoch", 1),
    nonce: exactBytes(value.nonce, NONCE_BYTES, "nameCt.nonce"),
    ct: exactBytes(value.ct, NAME_CIPHERTEXT_BYTES, "nameCt.ct"),
  }
}

async function parseDevice(value: unknown): Promise<DeviceDescriptor> {
  if (!isRecord(value)) malformed("device must be an object")
  onlyKeys(value, ["deviceId", "platform", "signPub", "encPub", "nameCt"], "device")
  if (!isDeviceId(value.deviceId)) malformed("device.deviceId is not a dev_ id")
  if (value.platform === "headless") {
    rule("headless devices cannot enroll in this protocol version")
  }
  if (!DEVICE_PLATFORMS.includes(value.platform as DevicePlatform)) {
    malformed("device.platform is unknown")
  }
  return {
    deviceId: value.deviceId,
    platform: value.platform as DevicePlatform,
    signPub: await signingPoint(value.signPub, "device.signPub"),
    encPub: await encryptionPoint(value.encPub, "device.encPub"),
    nameCt: parseNameCt(value.nameCt),
  }
}

async function parseRecovery(value: unknown): Promise<RecoveryKeys> {
  if (!isRecord(value)) malformed("recovery must be an object")
  onlyKeys(value, ["signPub", "encPub"], "recovery")
  return {
    signPub: await signingPoint(value.signPub, "recovery.signPub"),
    encPub: await encryptionPoint(value.encPub, "recovery.encPub"),
  }
}

function parseEpoch(value: unknown): EpochBlock {
  if (!isRecord(value)) malformed("epoch must be an object")
  onlyKeys(value, ["epoch", "keyCommit", "prevWrap"], "epoch")
  const epoch = integer(value.epoch, "epoch.epoch", 1)
  const keyCommit = exactBytes(value.keyCommit, HASH_BYTES, "epoch.keyCommit")
  if (epoch === 1) {
    if (value.prevWrap !== undefined) malformed("epoch 1 has no previous key to wrap")
    return { epoch, keyCommit }
  }
  if (!isRecord(value.prevWrap)) malformed("epoch.prevWrap is required after epoch 1")
  onlyKeys(value.prevWrap, ["nonce", "ct"], "epoch.prevWrap")
  return {
    epoch,
    keyCommit,
    prevWrap: {
      nonce: exactBytes(value.prevWrap.nonce, NONCE_BYTES, "epoch.prevWrap.nonce"),
      ct: exactBytes(value.prevWrap.ct, PREV_WRAP_BYTES, "epoch.prevWrap.ct"),
    },
  }
}

const BASE_KEYS = ["v", "spaceId", "seq", "prev", "type", "at"] as const

async function parseEntry(value: unknown, spaceId: string): Promise<RegistryEntry> {
  if (!isRecord(value)) malformed("entry must be an object")
  if (value.v !== 1) malformed("entry.v must be 1")
  if (value.spaceId !== spaceId) malformed("entry belongs to another space")
  const seq = integer(value.seq, "entry.seq")
  const prev = value.prev
  if (seq === 0 ? prev !== null : typeof prev !== "string") {
    malformed(seq === 0 ? "genesis has no previous entry" : "entry.prev must be a hash")
  }
  if (prev !== null) exactBytes(prev, HASH_BYTES, "entry.prev")
  const base = {
    v: 1 as const,
    spaceId,
    seq,
    prev: prev as string | null,
    at: integer(value.at, "entry.at"),
  }
  switch (value.type) {
    case "genesis":
      onlyKeys(value, [...BASE_KEYS, "device", "recovery", "epoch"], "genesis")
      return {
        ...base,
        type: "genesis",
        device: await parseDevice(value.device),
        recovery: await parseRecovery(value.recovery),
        epoch: parseEpoch(value.epoch),
      }
    case "add-device":
      if (value.via === "approval") {
        onlyKeys(
          value,
          [...BASE_KEYS, "via", "device", "requestId", "transcriptHash"],
          "add-device"
        )
        if (!isRequestId(value.requestId)) malformed("add-device.requestId is not a req_ id")
        return {
          ...base,
          type: "add-device",
          via: "approval",
          device: await parseDevice(value.device),
          requestId: value.requestId,
          transcriptHash: exactBytes(value.transcriptHash, HASH_BYTES, "add-device.transcriptHash"),
        }
      }
      if (value.via === "recovery") {
        onlyKeys(value, [...BASE_KEYS, "via", "device"], "add-device")
        return {
          ...base,
          type: "add-device",
          via: "recovery",
          device: await parseDevice(value.device),
        }
      }
      return malformed("add-device.via must be approval or recovery")
    case "revoke-device":
      onlyKeys(value, [...BASE_KEYS, "deviceId", "epoch"], "revoke-device")
      if (!isDeviceId(value.deviceId)) malformed("revoke-device.deviceId is not a dev_ id")
      return {
        ...base,
        type: "revoke-device",
        deviceId: value.deviceId,
        epoch: parseEpoch(value.epoch),
      }
    case "recovery-rotate":
      onlyKeys(value, [...BASE_KEYS, "recovery", "epoch"], "recovery-rotate")
      return {
        ...base,
        type: "recovery-rotate",
        recovery: await parseRecovery(value.recovery),
        epoch: parseEpoch(value.epoch),
      }
    case "epoch-rotate":
      onlyKeys(value, [...BASE_KEYS, "epoch"], "epoch-rotate")
      return { ...base, type: "epoch-rotate", epoch: parseEpoch(value.epoch) }
    default:
      return malformed("entry.type is unknown")
  }
}

function parseSignatures(value: unknown): EntrySignature[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    malformed("sigs must hold one or two signatures")
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) malformed(`sigs[${index}] must be an object`)
    onlyKeys(item, ["signer", "sig"], `sigs[${index}]`)
    const signer = item.signer
    if (signer !== RECOVERY_SIGNER && !isDeviceId(signer))
      malformed(`sigs[${index}].signer is invalid`)
    if (seen.has(signer as string)) malformed("a signer appears twice")
    seen.add(signer as string)
    return { signer: signer as string, sig: exactBytes(item.sig, 64, `sigs[${index}].sig`) }
  })
}

/** Parses one registry element; refuses anything not exactly in the protocol's shape. */
export async function parseSignedEntry(value: unknown, spaceId: string): Promise<SignedEntry> {
  if (!isRecord(value)) malformed("a registry element must be an object")
  onlyKeys(value, ["entry", "sigs"], "registry element")
  const signed = {
    entry: await parseEntry(value.entry, spaceId),
    sigs: parseSignatures(value.sigs),
  }
  if (canonicalJsonBytes(signed).length > MAX_ENTRY_BYTES) {
    rule(`a registry element is at most ${MAX_ENTRY_BYTES} bytes`)
  }
  return signed
}

function activeDevices(state: RegistryState): RegistryDevice[] {
  return Object.values(state.devices).filter((device) => device.status === "active")
}

function requireActive(state: RegistryState, deviceId: string, role: string): RegistryDevice {
  const device = state.devices[deviceId]
  if (!device || device.status !== "active") rule(`${role} ${deviceId} is not an active device`)
  return device
}

/** The signers an entry must carry, mapped to the public key each must verify against. */
function requiredSigners(
  state: RegistryState | null,
  entry: RegistryEntry,
  sigs: readonly EntrySignature[]
): Map<string, string> {
  const required = new Map<string, string>()
  const deviceSigners = sigs.map((sig) => sig.signer).filter((signer) => signer !== RECOVERY_SIGNER)
  switch (entry.type) {
    case "genesis":
      required.set(entry.device.deviceId, entry.device.signPub)
      required.set(RECOVERY_SIGNER, entry.recovery.signPub)
      return required
    case "add-device":
      if (entry.via === "recovery") {
        required.set(RECOVERY_SIGNER, state!.recovery.signPub)
        required.set(entry.device.deviceId, entry.device.signPub)
        return required
      }
      if (deviceSigners.length !== 1) rule("an approval is signed by exactly one device")
      required.set(deviceSigners[0]!, requireActive(state!, deviceSigners[0]!, "approver").signPub)
      return required
    case "recovery-rotate":
      if (deviceSigners.length !== 1) rule("a recovery change is signed by exactly one device")
      required.set(deviceSigners[0]!, requireActive(state!, deviceSigners[0]!, "signer").signPub)
      // The NEW recovery key countersigns: only its holder can install it.
      required.set(RECOVERY_SIGNER, entry.recovery.signPub)
      return required
    case "revoke-device":
    case "epoch-rotate":
      if (deviceSigners.length !== 1 || sigs.length !== 1)
        rule(`${entry.type} is signed by exactly one device`)
      required.set(deviceSigners[0]!, requireActive(state!, deviceSigners[0]!, "signer").signPub)
      return required
  }
}

async function verifySignatures(
  entry: RegistryEntry,
  sigs: readonly EntrySignature[],
  required: Map<string, string>
): Promise<void> {
  if (sigs.length !== required.size)
    throw new RegistryError("bad_signature", "wrong set of signers")
  const bytes = entrySigningBytes(entry)
  for (const sig of sigs) {
    const publicKey = required.get(sig.signer)
    if (!publicKey)
      throw new RegistryError("bad_signature", `${sig.signer} may not sign this entry`)
    const ok = await ecdsaVerify(fromBase64Url(publicKey), fromBase64Url(sig.sig), bytes)
    if (!ok) throw new RegistryError("bad_signature", `signature by ${sig.signer} does not verify`)
  }
}

function freshKeys(state: RegistryState, keys: readonly string[], what: string): void {
  const used = new Set(state.usedKeys)
  const seen = new Set<string>()
  for (const key of keys) {
    if (used.has(key) || seen.has(key)) rule(`${what} reuses a public key`)
    seen.add(key)
  }
}

function nextEpoch(state: RegistryState, block: EpochBlock): void {
  if (block.epoch !== state.epoch + 1) rule(`the next epoch must be ${state.epoch + 1}`)
}

function cloneState(state: RegistryState): RegistryState {
  return {
    ...state,
    head: { ...state.head },
    keyCommits: { ...state.keyCommits },
    prevWraps: { ...state.prevWraps },
    recovery: { ...state.recovery },
    devices: Object.fromEntries(
      Object.entries(state.devices).map(([id, device]) => [id, { ...device }])
    ),
    usedKeys: [...state.usedKeys],
  }
}

function startEpoch(next: RegistryState, block: EpochBlock): void {
  next.epoch = block.epoch
  next.keyCommits[block.epoch] = block.keyCommit
  if (block.prevWrap) next.prevWraps[block.epoch] = { ...block.prevWrap }
}

function addDevice(
  next: RegistryState,
  device: DeviceDescriptor,
  seq: number,
  via: RegistryDevice["addedVia"],
  addedBy: string | null
): void {
  next.devices[device.deviceId] = {
    ...device,
    nameCt: { ...device.nameCt },
    status: "active",
    addedSeq: seq,
    addedVia: via,
    addedBy,
    revokedSeq: null,
    revokedBy: null,
  }
  next.usedKeys.push(device.signPub, device.encPub)
}

function checkNewDevice(state: RegistryState, device: DeviceDescriptor): void {
  if (state.devices[device.deviceId]) rule(`device id ${device.deviceId} was already used`)
  freshKeys(state, [device.signPub, device.encPub], "the device")
  if (activeDevices(state).length >= MAX_ACTIVE_DEVICES) {
    rule(`at most ${MAX_ACTIVE_DEVICES} devices can be active`)
  }
  if (device.nameCt.epoch !== state.epoch)
    rule("the device name must be sealed under the current epoch")
}

/**
 * Validates `value` as the next registry element after `state` (null: the
 * space is empty, so it must be genesis) and returns the state after it.
 */
export async function validateAppend(
  state: RegistryState | null,
  value: unknown,
  spaceId: string
): Promise<{ state: RegistryState; signed: SignedEntry; hash: string }> {
  const signed = await parseSignedEntry(value, spaceId)
  const { entry, sigs } = signed

  if (state === null) {
    if (entry.type !== "genesis" || entry.seq !== 0) {
      throw new RegistryError("bad_genesis", "the first entry must be genesis")
    }
  } else {
    if (entry.type === "genesis") throw new RegistryError("bad_genesis", "genesis happens once")
    if (entry.seq !== state.head.seq + 1 || entry.prev !== state.head.hash) {
      throw new RegistryError("bad_link", "the entry does not extend the head")
    }
    if (state.pendingRecoveryRotate !== null) {
      const signer = sigs[0]?.signer
      if (entry.type !== "epoch-rotate" || signer !== state.pendingRecoveryRotate) {
        throw new RegistryError(
          "incomplete_batch",
          "a device added with the recovery key must rotate the epoch next"
        )
      }
    }
  }

  const required = requiredSigners(state, entry, sigs)
  await verifySignatures(entry, sigs, required)
  const hash = await entryHash(entry)

  if (entry.type === "genesis") {
    if (entry.epoch.epoch !== 1) rule("genesis starts epoch 1")
    if (entry.device.nameCt.epoch !== 1) rule("the genesis device name is sealed under epoch 1")
    const keys = [
      entry.device.signPub,
      entry.device.encPub,
      entry.recovery.signPub,
      entry.recovery.encPub,
    ]
    if (new Set(keys).size !== keys.length) rule("genesis reuses a public key")
    const next: RegistryState = {
      spaceId,
      genesisHash: hash,
      head: { seq: 0, hash },
      epoch: 0,
      keyCommits: {},
      prevWraps: {},
      recovery: { ...entry.recovery },
      devices: {},
      usedKeys: [entry.recovery.signPub, entry.recovery.encPub],
      pendingRecoveryRotate: null,
    }
    addDevice(next, entry.device, 0, "genesis", null)
    startEpoch(next, entry.epoch)
    return { state: next, signed, hash }
  }

  const current = state!
  const next = cloneState(current)
  next.head = { seq: entry.seq, hash }
  next.pendingRecoveryRotate = null

  switch (entry.type) {
    case "add-device": {
      checkNewDevice(current, entry.device)
      if (entry.via === "approval") {
        addDevice(next, entry.device, entry.seq, "approval", sigs[0]!.signer)
      } else {
        addDevice(next, entry.device, entry.seq, "recovery", RECOVERY_SIGNER)
        next.pendingRecoveryRotate = entry.device.deviceId
      }
      break
    }
    case "revoke-device": {
      const signer = sigs[0]!.signer
      const target = requireActive(current, entry.deviceId, "the revoked device")
      if (target.deviceId === signer) rule("a device cannot revoke itself")
      if (activeDevices(current).length <= 1) rule("the last active device cannot be revoked")
      nextEpoch(current, entry.epoch)
      next.devices[entry.deviceId] = {
        ...next.devices[entry.deviceId]!,
        status: "revoked",
        revokedSeq: entry.seq,
        revokedBy: signer,
      }
      startEpoch(next, entry.epoch)
      break
    }
    case "recovery-rotate": {
      freshKeys(current, [entry.recovery.signPub, entry.recovery.encPub], "the recovery key")
      nextEpoch(current, entry.epoch)
      next.recovery = { ...entry.recovery }
      next.usedKeys.push(entry.recovery.signPub, entry.recovery.encPub)
      startEpoch(next, entry.epoch)
      break
    }
    case "epoch-rotate": {
      nextEpoch(current, entry.epoch)
      startEpoch(next, entry.epoch)
      break
    }
  }
  return { state: next, signed, hash }
}

/** Active devices in registry order (oldest first). */
export function listActiveDevices(state: RegistryState): RegistryDevice[] {
  return activeDevices(state).sort((a, b) => a.addedSeq - b.addedSeq)
}
