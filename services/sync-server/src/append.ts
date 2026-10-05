/**
 * Validating `POST /v1/registry` (protocol §5.5, §5.6): one entry, or the
 * recovery batch (a recovery add followed by the new device's rotation),
 * plus the envelopes the change requires.
 *
 * - A batch that starts a new epoch carries exactly one envelope per active
 *   device after it plus one for the recovery key, each sealed to the key the
 *   registry holds; they replace the previous epoch's set.
 * - An approval adds one envelope, for the new device, under the current epoch.
 */

import {
  MAX_BATCH_ENTRIES,
  RECOVERY_SIGNER,
  RegistryError,
  checkEnvelopeSet,
  EnvelopeError,
  expectedRecipients,
  validateAppend,
  type AddDeviceByApprovalEntry,
  type EpochEnvelope,
  type RegistryState,
  type SignedEntry,
} from "@cognia/sync-protocol"

import { SyncHttpError } from "./http"

export interface AppendPlan {
  state: RegistryState
  entries: { seq: number; hash: string; signed: SignedEntry }[]
  envelopes: { mode: "replace" | "add"; list: EpochEnvelope[] }
  /** The approval this batch completes, if any. */
  approval: AddDeviceByApprovalEntry | null
  /** Devices that signed the first entry (the proof must come from one of them). */
  deviceSigners: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function registryRefusal(error: unknown): SyncHttpError {
  if (error instanceof RegistryError) {
    if (error.code === "bad_link")
      return new SyncHttpError(409, "head_moved", "the device list changed; fetch it and retry")
    return new SyncHttpError(400, "invalid_entry", `${error.code}: ${error.message}`)
  }
  throw error
}

export async function planAppend(state: RegistryState, body: unknown): Promise<AppendPlan> {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "entries" && key !== "envelopes")
  ) {
    throw new SyncHttpError(400, "bad_request", "expected {entries, envelopes}")
  }
  const { entries, envelopes } = body
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BATCH_ENTRIES) {
    throw new SyncHttpError(400, "bad_request", `entries holds 1 to ${MAX_BATCH_ENTRIES} entries`)
  }
  if (!Array.isArray(envelopes))
    throw new SyncHttpError(400, "bad_request", "envelopes must be an array")

  let next = state
  const planned: AppendPlan["entries"] = []
  for (const element of entries) {
    try {
      const result = await validateAppend(next, element, state.spaceId)
      next = result.state
      planned.push({ seq: result.signed.entry.seq, hash: result.hash, signed: result.signed })
    } catch (error) {
      throw registryRefusal(error)
    }
  }
  const first = planned[0]!.signed
  const isRecoveryBatch = first.entry.type === "add-device" && first.entry.via === "recovery"
  if (planned.length === 2 && !isRecoveryBatch) {
    throw new SyncHttpError(400, "invalid_entry", "only a recovery add travels with a second entry")
  }
  if (next.pendingRecoveryRotate !== null) {
    throw new SyncHttpError(
      400,
      "invalid_entry",
      "incomplete_batch: a recovery add must come with its rotation"
    )
  }

  const approval =
    first.entry.type === "add-device" && first.entry.via === "approval" ? first.entry : null
  try {
    const list =
      next.epoch > state.epoch
        ? checkEnvelopeSet(envelopes, next.epoch, expectedRecipients(next))
        : approval
          ? checkEnvelopeSet(envelopes, next.epoch, [
              { recipient: approval.device.deviceId, encPub: approval.device.encPub },
            ])
          : null
    if (!list) throw new EnvelopeError("this change carries no envelopes")
    return {
      state: next,
      entries: planned,
      envelopes: { mode: next.epoch > state.epoch ? "replace" : "add", list },
      approval,
      deviceSigners: first.sigs
        .map((sig) => sig.signer)
        .filter((signer) => signer !== RECOVERY_SIGNER),
    }
  } catch (error) {
    if (error instanceof EnvelopeError)
      throw new SyncHttpError(400, "envelopes_incomplete", error.message)
    throw error
  }
}
