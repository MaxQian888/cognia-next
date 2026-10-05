/**
 * A new device asking to join (protocol §5.2, the new device's side).
 *
 * 1. `startJoin` verifies the list (its genesis becomes this request's G_R),
 *    makes device keys and `nonceR`, seals its name to every active device
 *    and posts the commitment.
 * 2. `pollJoin` reveals `nonceR` once an approver's nonce is in, and only
 *    then shows the code, computed from this device's own values.
 * 3. `completeJoin`, after approval, requires the same genesis, its own
 *    `add-device` signed by that approver with the transcript both sides
 *    computed, and then keeps the keys and opens its envelope.
 *
 * The request lives in memory: a reload abandons it (it expires in 15 min).
 */

import {
  fitDeviceName,
  fromBase64Url,
  listActiveDevices,
  toBase64Url,
  transcriptHash,
  type FoldedRegistry,
} from "@cognia/sync-protocol"

import {
  displayedSasCode,
  enrollRequestPop,
  generateDeviceKeyMaterial,
  importDeviceKeys,
  newRequesterNonce,
  sealRequestName,
  wipeNonce,
  type DeviceKeyMaterial,
  type DeviceKeys,
} from "../crypto"
import { currentKeyChain, verifyRegistry } from "../registry-sync"
import type { AccountSyncContext } from "./context"
import { EnrollmentError } from "./errors"
import type { DeviceIdentityInput } from "./first-device"
import { approvalTranscript } from "./transcript"

export interface JoinRequest {
  requestId: string
  expiresAt: number
  input: DeviceIdentityInput
  material: DeviceKeyMaterial
  keys: DeviceKeys
  nonceR: Uint8Array
  commit: string
  /** The genesis this device saw when it asked (G_R). */
  genesisHash: string
  revealed: boolean
  approverDeviceId: string | null
}

export type JoinProgress =
  | { phase: "waiting" }
  | { phase: "code"; code: string; approverDeviceId: string }
  | { phase: "approved" }
  | { phase: "ended"; reason: "denied" | "mismatch" | "cancelled" | "expired" }

export async function startJoin(
  context: AccountSyncContext,
  input: DeviceIdentityInput
): Promise<JoinRequest> {
  context.vault.assertAvailable()
  const registry = await verifyRegistry(context.api, context.vault)
  if (!registry) throw new EnrollmentError("space-empty", "this account has no sync devices yet")
  const { spaceId } = context.session
  const material = await generateDeviceKeyMaterial()
  const keys = await importDeviceKeys(material)
  const { nonceR, commit } = await newRequesterNonce()
  const name = fitDeviceName(input.name)
  const names = await Promise.all(
    listActiveDevices(registry.state).map((device) =>
      sealRequestName(name, spaceId, keys.deviceId, {
        recipient: device.deviceId,
        encPub: device.encPub,
      })
    )
  )
  const body = {
    deviceId: keys.deviceId,
    platform: input.platform,
    signPub: keys.signPub,
    encPub: keys.encPub,
    commit,
    names,
  }
  const created = await context.api.createRequest({
    ...body,
    pop: await enrollRequestPop(keys, body),
  })
  return {
    requestId: created.requestId,
    expiresAt: created.expiresAt,
    input,
    material,
    keys,
    nonceR,
    commit,
    genesisHash: registry.state.genesisHash,
    revealed: false,
    approverDeviceId: null,
  }
}

function transcriptOf(context: AccountSyncContext, join: JoinRequest, approverDeviceId: string) {
  return approvalTranscript({
    spaceId: context.session.spaceId,
    genesisHash: join.genesisHash,
    requestId: join.requestId,
    deviceId: join.keys.deviceId,
    platform: join.input.platform,
    signPub: join.keys.signPub,
    encPub: join.keys.encPub,
    commit: join.commit,
    approverDeviceId,
  })
}

export async function pollJoin(
  context: AccountSyncContext,
  join: JoinRequest
): Promise<JoinProgress> {
  const view = await context.api.getRequest(join.keys, join.requestId)
  switch (view.state) {
    case "pending":
      return { phase: "waiting" }
    case "nonce_set":
    case "revealed": {
      if (!view.nonceA || !view.approverDeviceId) return { phase: "waiting" }
      if (join.approverDeviceId && join.approverDeviceId !== view.approverDeviceId) {
        // The approver cannot change after the reveal; treat it as a mismatch.
        return { phase: "ended", reason: "mismatch" }
      }
      if (!join.revealed) {
        await context.api.reveal(join.keys, join.requestId, toBase64Url(join.nonceR))
        join.revealed = true
      }
      join.approverDeviceId = view.approverDeviceId
      const code = await displayedSasCode(
        join.nonceR,
        fromBase64Url(view.nonceA),
        transcriptOf(context, join, view.approverDeviceId)
      )
      return { phase: "code", code, approverDeviceId: view.approverDeviceId }
    }
    case "approved":
      if (!join.approverDeviceId && view.approverDeviceId)
        join.approverDeviceId = view.approverDeviceId
      return { phase: "approved" }
    default:
      return { phase: "ended", reason: view.state }
  }
}

/** Accepts the approval only as the verified list proves it, then keeps the keys. */
export async function completeJoin(
  context: AccountSyncContext,
  join: JoinRequest
): Promise<FoldedRegistry> {
  if (!join.revealed || !join.approverDeviceId) {
    throw new EnrollmentError(
      "approval-unverified",
      "this device never revealed its nonce to an approver"
    )
  }
  const registry = await verifyRegistry(context.api, context.vault)
  if (!registry || registry.state.genesisHash !== join.genesisHash) {
    throw new EnrollmentError(
      "genesis-changed",
      "the device list is not the one this device asked to join"
    )
  }
  const expected = await transcriptHash(transcriptOf(context, join, join.approverDeviceId))
  const added = registry.entries.find(
    ({ signed }) =>
      signed.entry.type === "add-device" &&
      signed.entry.via === "approval" &&
      signed.entry.device.deviceId === join.keys.deviceId
  )
  const entry = added?.signed.entry
  if (
    !added ||
    entry?.type !== "add-device" ||
    entry.via !== "approval" ||
    entry.requestId !== join.requestId ||
    entry.transcriptHash !== expected ||
    entry.device.signPub !== join.keys.signPub ||
    entry.device.encPub !== join.keys.encPub ||
    added.signed.sigs.length !== 1 ||
    added.signed.sigs[0]!.signer !== join.approverDeviceId
  ) {
    throw new EnrollmentError(
      "approval-unverified",
      "the device list does not hold this device's approval"
    )
  }
  const keys = await context.vault.saveDeviceKeys(join.material)
  await currentKeyChain(context.api, context.vault, registry.state, keys)
  wipeNonce(join.nonceR)
  return registry
}

export async function cancelJoin(context: AccountSyncContext, join: JoinRequest): Promise<void> {
  await context.api.cancelRequest(join.keys, join.requestId)
  wipeNonce(join.nonceR)
}
