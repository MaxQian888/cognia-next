/**
 * The op log's push and pull rules (protocol §7.3, §7.5), kept apart from the
 * Durable Object so they can be checked without one.
 *
 * A push comes from one active device. Its ops must continue that device's
 * sequence (a resent prefix is acknowledged, not stored twice), be sealed
 * under the registry's current epoch, and each carry a valid signature by
 * the device. The server never reads inside `ct`.
 */

import {
  MAX_OPS_PER_PUSH,
  OpError,
  importEcdsaPublicKey,
  fromBase64Url,
  parseOp,
  verifyOpSignature,
  type Op,
  type RegistryState,
} from "@cognia/sync-protocol"

import { SyncHttpError } from "./http"

/** Pulls return whole batches, up to about this many bytes (at least one batch). */
export const PULL_MAX_BYTES = 1024 * 1024
export const PULL_MAX_BATCHES = 64
/** Above this many stored op bytes the space accepts no more ops until 3b compaction (§14). */
export const OPLOG_READONLY_BYTES = Math.floor(2 * 1024 ** 3 * 1.25)
/** Longest a pull may wait for new ops, seconds. */
export const MAX_PULL_WAIT_S = 25

export interface PushPlan {
  /** The new ops, in order; empty when the whole push was already stored. */
  ops: Op[]
  /** The device's last sequence number once this push is stored. */
  lastDeviceSeq: number
}

function badRequest(message: string): SyncHttpError {
  return new SyncHttpError(400, "bad_request", message)
}

export async function planPush(input: {
  state: RegistryState
  spaceId: string
  deviceId: string
  /** The device's last stored sequence number, 0 if none. */
  lastDeviceSeq: number
  body: unknown
}): Promise<PushPlan> {
  const { state, spaceId, deviceId, lastDeviceSeq, body } = input
  const raw = (body as { ops?: unknown } | null)?.ops
  if (
    typeof body !== "object" ||
    body === null ||
    Object.keys(body).some((key) => key !== "ops") ||
    !Array.isArray(raw)
  ) {
    throw badRequest("expected {ops}")
  }
  if (raw.length === 0 || raw.length > MAX_OPS_PER_PUSH)
    throw badRequest(`a push carries 1 to ${MAX_OPS_PER_PUSH} ops`)
  let ops: Op[]
  try {
    ops = raw.map(parseOp)
  } catch (error) {
    if (error instanceof OpError) throw badRequest(error.message)
    throw error
  }
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.deviceId !== deviceId)
      throw badRequest("every op must come from the pushing device")
    if (i > 0 && ops[i]!.deviceSeq !== ops[i - 1]!.deviceSeq + 1)
      throw badRequest("the ops' sequence numbers must be consecutive")
  }
  const fresh = ops.filter((op) => op.deviceSeq > lastDeviceSeq)
  if (fresh.length === 0) return { ops: [], lastDeviceSeq }
  if (fresh[0]!.deviceSeq !== lastDeviceSeq + 1) {
    throw new SyncHttpError(409, "seq_gap", "ops are missing before this push", {
      expected: lastDeviceSeq + 1,
    })
  }
  if (fresh.some((op) => op.epoch !== state.epoch)) {
    throw new SyncHttpError(409, "epoch_stale", "the sync key changed; fetch the new one", {
      epoch: state.epoch,
    })
  }
  const signPub = state.devices[deviceId]!.signPub
  const key = await importEcdsaPublicKey(fromBase64Url(signPub))
  for (const op of fresh) {
    if (!(await verifyOpSignature(key, spaceId, op)))
      throw badRequest(`op ${op.deviceSeq} has a bad signature`)
  }
  return { ops: fresh, lastDeviceSeq: fresh.at(-1)!.deviceSeq }
}

/** `?after=` and `?wait=` of a pull, checked. */
export function parsePullQuery(
  after: string | null,
  wait: string | null
): {
  after: number
  waitS: number
} {
  const parsedAfter = after === null || after === "" ? 0 : Number(after)
  if (
    !Number.isSafeInteger(parsedAfter) ||
    parsedAfter < 0 ||
    (after && after !== String(parsedAfter))
  )
    throw badRequest("after must be an integer ≥ 0")
  const parsedWait = wait === null || wait === "" ? 0 : Number(wait)
  if (
    !Number.isInteger(parsedWait) ||
    parsedWait < 0 ||
    parsedWait > MAX_PULL_WAIT_S ||
    (wait && wait !== String(parsedWait))
  ) {
    throw badRequest(`wait must be an integer from 0 to ${MAX_PULL_WAIT_S}`)
  }
  return { after: parsedAfter, waitS: parsedWait }
}
