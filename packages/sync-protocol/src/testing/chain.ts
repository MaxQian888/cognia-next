/**
 * Test support: real keys and correctly signed registry chains, for this
 * package's tests, the sync Worker's tests and the client's enrollment tests.
 * Not exported from the package root; import `@cognia/sync-protocol/testing/chain`.
 */

import { toBase64Url } from "../bytes"
import { exportRawPublicKey } from "../crypto"
import { keyCommitment, newEpochKey, sealDeviceName, wrapPreviousKey } from "../epoch"
import { newDeviceId, newRequestId } from "../ids"
import { signEntry } from "../registry/encode"
import {
  RECOVERY_SIGNER,
  type DevicePlatform,
  type EpochBlock,
  type RegistryEntry,
  type RegistryState,
  type SignedEntry,
} from "../registry/types"
import { validateAppend } from "../registry/validate-append"

export interface TestKeyPair {
  sign: CryptoKeyPair
  enc: CryptoKeyPair
  signPub: string
  encPub: string
}

export interface TestDevice extends TestKeyPair {
  deviceId: string
  platform: DevicePlatform
  name: string
}

async function keyPair(): Promise<TestKeyPair> {
  const sign = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const enc = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  return {
    sign,
    enc,
    signPub: toBase64Url(await exportRawPublicKey(sign.publicKey)),
    encPub: toBase64Url(await exportRawPublicKey(enc.publicKey)),
  }
}

export async function makeDevice(
  name = "Test device",
  platform: DevicePlatform = "desktop"
): Promise<TestDevice> {
  return { ...(await keyPair()), deviceId: newDeviceId(), platform, name }
}

export async function makeRecovery(): Promise<TestKeyPair> {
  return keyPair()
}

export type Signer = { signer: string; key: CryptoKey }

export function deviceSigner(device: TestKeyPair & { deviceId: string }): Signer {
  return { signer: device.deviceId, key: device.sign.privateKey }
}

export function recoverySigner(recovery: TestKeyPair): Signer {
  return { signer: RECOVERY_SIGNER, key: recovery.sign.privateKey }
}

export async function signWith(
  entry: RegistryEntry,
  signers: readonly Signer[]
): Promise<SignedEntry> {
  return { entry, sigs: await Promise.all(signers.map((s) => signEntry(entry, s.signer, s.key))) }
}

/** Builds a valid chain step by step, keeping every epoch key. */
export class ChainBuilder {
  readonly entries: SignedEntry[] = []
  readonly epochKeys = new Map<number, Uint8Array>()
  state!: RegistryState
  private clock = 1_700_000_000_000

  private constructor(readonly spaceId: string) {}

  static async genesis(
    spaceId: string,
    device: TestDevice,
    recovery: TestKeyPair
  ): Promise<ChainBuilder> {
    const builder = new ChainBuilder(spaceId)
    const key = newEpochKey()
    builder.epochKeys.set(1, key)
    const entry: RegistryEntry = {
      v: 1,
      spaceId,
      seq: 0,
      prev: null,
      type: "genesis",
      at: builder.tick(),
      device: await builder.descriptor(device, 1),
      recovery: { signPub: recovery.signPub, encPub: recovery.encPub },
      epoch: { epoch: 1, keyCommit: await keyCommitment(key, spaceId, 1) },
    }
    await builder.push(await signWith(entry, [deviceSigner(device), recoverySigner(recovery)]))
    return builder
  }

  /** An independent copy at the same head, to build a diverging history. */
  fork(): ChainBuilder {
    const copy = new ChainBuilder(this.spaceId)
    copy.entries.push(...this.entries)
    for (const [epoch, key] of this.epochKeys) copy.epochKeys.set(epoch, key)
    copy.state = this.state
    copy.clock = this.clock
    return copy
  }

  tick(): number {
    this.clock += 1000
    return this.clock
  }

  get epoch(): number {
    return this.state.epoch
  }

  currentKey(): Uint8Array {
    return this.epochKeys.get(this.state.epoch)!
  }

  async descriptor(device: TestDevice, epoch = this.state.epoch) {
    const key = this.epochKeys.get(epoch)!
    return {
      deviceId: device.deviceId,
      platform: device.platform,
      signPub: device.signPub,
      encPub: device.encPub,
      nameCt: await sealDeviceName(key, this.spaceId, device.deviceId, epoch, device.name),
    }
  }

  /** The next epoch's block, with a fresh key kept in `epochKeys`. */
  async nextEpochBlock(): Promise<EpochBlock> {
    const epoch = this.state.epoch + 1
    const key = newEpochKey()
    this.epochKeys.set(epoch, key)
    return {
      epoch,
      keyCommit: await keyCommitment(key, this.spaceId, epoch),
      prevWrap: await wrapPreviousKey(key, this.currentKey(), this.spaceId, epoch),
    }
  }

  base() {
    return {
      v: 1 as const,
      spaceId: this.spaceId,
      seq: this.state.head.seq + 1,
      prev: this.state.head.hash,
      at: this.tick(),
    }
  }

  async push(signed: SignedEntry): Promise<void> {
    const result = await validateAppend(
      this.entries.length ? this.state : null,
      signed,
      this.spaceId
    )
    this.state = result.state
    this.entries.push(signed)
  }

  async addByApproval(
    approver: TestDevice,
    device: TestDevice,
    extra: { requestId?: string; transcriptHash?: string } = {}
  ): Promise<SignedEntry> {
    const entry: RegistryEntry = {
      ...this.base(),
      type: "add-device",
      via: "approval",
      device: await this.descriptor(device),
      requestId: extra.requestId ?? newRequestId(),
      transcriptHash: extra.transcriptHash ?? toBase64Url(new Uint8Array(32).fill(7)),
    }
    const signed = await signWith(entry, [deviceSigner(approver)])
    await this.push(signed)
    return signed
  }

  /** Appends the recovery batch: the add, then the rotation by the new device. */
  async addByRecovery(recovery: TestKeyPair, device: TestDevice): Promise<SignedEntry[]> {
    const add: RegistryEntry = {
      ...this.base(),
      type: "add-device",
      via: "recovery",
      device: await this.descriptor(device),
    }
    const signedAdd = await signWith(add, [recoverySigner(recovery), deviceSigner(device)])
    await this.push(signedAdd)
    const rotate: RegistryEntry = {
      ...this.base(),
      type: "epoch-rotate",
      epoch: await this.nextEpochBlock(),
    }
    const signedRotate = await signWith(rotate, [deviceSigner(device)])
    await this.push(signedRotate)
    return [signedAdd, signedRotate]
  }

  async revoke(signer: TestDevice, deviceId: string): Promise<SignedEntry> {
    const entry: RegistryEntry = {
      ...this.base(),
      type: "revoke-device",
      deviceId,
      epoch: await this.nextEpochBlock(),
    }
    const signed = await signWith(entry, [deviceSigner(signer)])
    await this.push(signed)
    return signed
  }

  async rotateRecovery(signer: TestDevice, next: TestKeyPair): Promise<SignedEntry> {
    const entry: RegistryEntry = {
      ...this.base(),
      type: "recovery-rotate",
      recovery: { signPub: next.signPub, encPub: next.encPub },
      epoch: await this.nextEpochBlock(),
    }
    const signed = await signWith(entry, [deviceSigner(signer), recoverySigner(next)])
    await this.push(signed)
    return signed
  }

  async rotateEpoch(signer: TestDevice): Promise<SignedEntry> {
    const entry: RegistryEntry = {
      ...this.base(),
      type: "epoch-rotate",
      epoch: await this.nextEpochBlock(),
    }
    const signed = await signWith(entry, [deviceSigner(signer)])
    await this.push(signed)
    return signed
  }
}
