/**
 * Approving a new device (protocol §5.2, the approver's side).
 *
 * - `listIncoming` shows the waiting requests with the names sealed to
 *   this device.
 * - `beginApproval` captures the request as this device sees it NOW, then
 *   posts a fresh `nonceA` that lives only in memory. Everything the code
 *   binds is fixed from here on.
 * - `pollApproval` waits for the reveal, checks `nonceR` against the
 *   captured commitment itself, and shows the code.
 * - `confirmApproval`, once the person says the codes match, appends the
 *   `add-device` with the transcript hash and seals the epoch key to the
 *   new device.
 */

import {
  fitDeviceName,
  fromBase64Url,
  matchesSasCommit,
  pinFor,
  sealDeviceName,
  toBase64Url,
  transcriptHash,
  validateAppend,
  type DevicePlatform,
  type RegistryEntry,
} from "@cognia/sync-protocol"

import {
  displayedSasCode,
  newApproverNonce,
  openRequestName,
  sealEpochEnvelope,
  signRegistryEntry,
  wipeNonce,
  type DeviceKeys,
} from "../crypto"
import { currentKeyChain, verifyRegistry } from "../registry-sync"
import { SyncApiError, type IncomingRequestView } from "../sync-api"
import type { AccountSyncContext } from "./context"
import { EnrollmentError } from "./errors"
import { withSpaceLock } from "./lock"
import { approvalTranscript } from "./transcript"

export interface IncomingRequest extends IncomingRequestView {
  /** The name the new device sealed to this device; null if it did not open. */
  displayName: string | null
}

export async function listIncoming(
  context: AccountSyncContext,
  device: DeviceKeys
): Promise<IncomingRequest[]> {
  const views = await context.api.listRequests(device)
  return Promise.all(
    views.map(async (view) => {
      let displayName: string | null = null
      if (view.name) {
        try {
          displayName = await openRequestName(
            view.name,
            device.enc,
            context.session.spaceId,
            view.deviceId,
            device.deviceId
          )
        } catch {
          displayName = null
        }
      }
      return { ...view, displayName }
    })
  )
}

export interface Approval {
  request: {
    requestId: string
    deviceId: string
    platform: DevicePlatform
    signPub: string
    encPub: string
    commit: string
  }
  displayName: string | null
  nonceA: Uint8Array
  nonceR: Uint8Array | null
  genesisHash: string
}

export type ApprovalProgress =
  | { phase: "waiting-reveal" }
  | { phase: "code"; code: string }
  | { phase: "ended"; reason: "denied" | "mismatch" | "cancelled" | "expired" | "approved" }

export async function beginApproval(
  context: AccountSyncContext,
  device: DeviceKeys,
  incoming: IncomingRequest
): Promise<Approval> {
  const registry = await verifyRegistry(context.api, context.vault)
  if (!registry || registry.state.devices[device.deviceId]?.status !== "active") {
    throw new EnrollmentError(
      "not-enrolled",
      "this device cannot approve: it is not an active device"
    )
  }
  const approval: Approval = {
    request: {
      requestId: incoming.requestId,
      deviceId: incoming.deviceId,
      platform: incoming.platform,
      signPub: incoming.signPub,
      encPub: incoming.encPub,
      commit: incoming.commit,
    },
    displayName: incoming.displayName,
    nonceA: newApproverNonce(),
    nonceR: null,
    genesisHash: registry.state.genesisHash,
  }
  await context.api.postNonce(device, incoming.requestId, toBase64Url(approval.nonceA))
  return approval
}

function transcriptOf(context: AccountSyncContext, device: DeviceKeys, approval: Approval) {
  return approvalTranscript({
    spaceId: context.session.spaceId,
    genesisHash: approval.genesisHash,
    ...approval.request,
    approverDeviceId: device.deviceId,
  })
}

export async function pollApproval(
  context: AccountSyncContext,
  device: DeviceKeys,
  approval: Approval
): Promise<ApprovalProgress> {
  const view = (await context.api.listRequests(device)).find(
    (item) => item.requestId === approval.request.requestId
  )
  if (!view) return { phase: "ended", reason: "expired" }
  if (view.state === "nonce_set") return { phase: "waiting-reveal" }
  if (view.state !== "revealed")
    return { phase: "ended", reason: view.state === "pending" ? "expired" : view.state }
  if (!view.nonceR) return { phase: "waiting-reveal" }
  const nonceR = fromBase64Url(view.nonceR)
  if (!(await matchesSasCommit(nonceR, approval.request.commit))) {
    await context.api.deny(device, approval.request.requestId, "mismatch").catch(() => {})
    wipeNonce(approval.nonceA)
    throw new EnrollmentError(
      "commit-mismatch",
      "the new device's nonce does not match what it committed to"
    )
  }
  approval.nonceR = nonceR
  return {
    phase: "code",
    code: await displayedSasCode(nonceR, approval.nonceA, transcriptOf(context, device, approval)),
  }
}

/** The person confirmed the codes match: add the device and seal it the current key. */
export function confirmApproval(
  context: AccountSyncContext,
  device: DeviceKeys,
  approval: Approval
): Promise<void> {
  if (!approval.nonceR) {
    return Promise.reject(
      new EnrollmentError("approval-unverified", "no code was shown for this request yet")
    )
  }
  const { spaceId } = context.session
  return withSpaceLock(spaceId, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const registry = await verifyRegistry(context.api, context.vault)
      if (!registry || registry.state.genesisHash !== approval.genesisHash) {
        throw new EnrollmentError("genesis-changed", "the device list changed under this approval")
      }
      const { state } = registry
      const chain = await currentKeyChain(context.api, context.vault, state, device)
      const key = chain.get(state.epoch)!
      const { request } = approval
      const entry: RegistryEntry = {
        v: 1,
        spaceId,
        seq: state.head.seq + 1,
        prev: state.head.hash,
        type: "add-device",
        at: context.now(),
        via: "approval",
        device: {
          deviceId: request.deviceId,
          platform: request.platform,
          signPub: request.signPub,
          encPub: request.encPub,
          nameCt: await sealDeviceName(
            key,
            spaceId,
            request.deviceId,
            state.epoch,
            fitDeviceName(approval.displayName ?? "")
          ),
        },
        requestId: request.requestId,
        transcriptHash: await transcriptHash(transcriptOf(context, device, approval)),
      }
      const signed = await signRegistryEntry(entry, [{ kind: "device", keys: device }])
      const { state: next } = await validateAppend(state, signed, spaceId)
      const envelope = await sealEpochEnvelope(spaceId, state.epoch, key, {
        recipient: request.deviceId,
        encPub: request.encPub,
      })
      try {
        await context.api.append(device, [signed], [envelope])
      } catch (error) {
        if (error instanceof SyncApiError && error.code === "head_moved") continue
        throw error
      }
      await context.vault.advancePin(pinFor(next))
      wipeNonce(approval.nonceA)
      return
    }
    throw new EnrollmentError("busy", "the device list kept changing; try again")
  })
}

/** Turn a request down: before any code (`denied`), or because the codes differ (`mismatch`). */
export async function denyRequest(
  context: AccountSyncContext,
  device: DeviceKeys,
  requestId: string,
  reason: "denied" | "mismatch",
  approval?: Approval
): Promise<void> {
  await context.api.deny(device, requestId, reason)
  if (approval) wipeNonce(approval.nonceA)
}
