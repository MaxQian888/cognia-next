/**
 * Enrollment requests (protocol §5.2): validation of a new device's request,
 * the commit-then-reveal state machine, and what each party may see.
 *
 *   pending ──nonce (approver)──▶ nonce_set ──reveal (new device)──▶ revealed ──append──▶ approved
 *      └──────────── deny / cancel / expiry ──▶ denied · mismatch · cancelled · expired
 *
 * The new device sees the approver's nonce once it is set. The approver sees
 * the new device's nonce once it is revealed (and checks it against the
 * commitment itself). Nobody is shown the approver's nonce back.
 */

import {
  DEVICE_PLATFORMS,
  SAS_NONCE_BYTES,
  checkSealedNames,
  ecdsaVerify,
  EnvelopeError,
  enrollRequestSigningBytes,
  fromBase64Url,
  fromBase64UrlExact,
  importEcdsaPublicKey,
  assertEcdhPublicKey,
  isDeviceId,
  matchesSasCommit,
  transcriptHash,
  type DevicePlatform,
  type RegistryState,
  type SealedName,
} from "@cognia/sync-protocol"

import { SyncHttpError } from "./http"
import { isOpenState, type RequestRow } from "./store"

export interface CreateRequestBody {
  deviceId: string
  platform: DevicePlatform
  signPub: string
  encPub: string
  commit: string
  names: SealedName[]
}

const CREATE_KEYS = ["deviceId", "platform", "signPub", "encPub", "commit", "names", "pop"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function badRequest(message: string): never {
  throw new SyncHttpError(400, "bad_request", message)
}

function exact(value: unknown, length: number, what: string): string {
  try {
    fromBase64UrlExact(value, length, what)
  } catch (error) {
    badRequest(error instanceof Error ? error.message : `${what} is invalid`)
  }
  return value as string
}

/** Validates a new device's request against the space, including its proof of possession. */
export async function parseCreateRequest(
  body: unknown,
  state: RegistryState
): Promise<CreateRequestBody> {
  if (!isRecord(body)) badRequest("expected a JSON object")
  for (const key of Object.keys(body))
    if (!CREATE_KEYS.includes(key)) badRequest(`unknown field ${key}`)
  const { deviceId, platform, pop } = body
  if (!isDeviceId(deviceId)) badRequest("deviceId is not a dev_ id")
  if (platform === "headless") badRequest("headless devices cannot enroll in this protocol version")
  if (!DEVICE_PLATFORMS.includes(platform as DevicePlatform)) badRequest("platform is unknown")
  const signPub = exact(body.signPub, 65, "signPub")
  const encPub = exact(body.encPub, 65, "encPub")
  try {
    await importEcdsaPublicKey(fromBase64Url(signPub))
    await assertEcdhPublicKey(fromBase64Url(encPub))
  } catch {
    badRequest("a public key is not a P-256 point")
  }
  const commit = exact(body.commit, 32, "commit")
  if (state.devices[deviceId]) badRequest("this device id is already in the device list")
  if (signPub === encPub || state.usedKeys.includes(signPub) || state.usedKeys.includes(encPub)) {
    badRequest("a public key was already used in this account")
  }
  let names: SealedName[]
  try {
    names = checkSealedNames(body.names, state)
  } catch (error) {
    badRequest(error instanceof EnvelopeError ? error.message : "names are invalid")
  }
  const { pop: _pop, ...withoutPop } = body
  const sig = exact(pop, 64, "pop")
  if (
    !(await ecdsaVerify(
      fromBase64Url(signPub),
      fromBase64Url(sig),
      enrollRequestSigningBytes(withoutPop)
    ))
  ) {
    throw new SyncHttpError(401, "bad_proof", "the request's proof of possession does not verify")
  }
  return { deviceId, platform: platform as DevicePlatform, signPub, encPub, commit, names }
}

export function parseNonce(body: unknown, field: "nonceA" | "nonceR"): string {
  if (!isRecord(body) || Object.keys(body).length !== 1) badRequest(`expected {${field}}`)
  return exact(body[field], SAS_NONCE_BYTES, field)
}

export type DenyReason = "denied" | "mismatch"

export function parseDeny(body: unknown): DenyReason {
  if (!isRecord(body) || Object.keys(body).length !== 1) badRequest("expected {reason}")
  if (body.reason !== "denied" && body.reason !== "mismatch")
    badRequest("reason is denied or mismatch")
  return body.reason
}

export function requireState(row: RequestRow, ...states: RequestRow["state"][]): void {
  if (row.state === "expired")
    throw new SyncHttpError(410, "request_expired", "the request expired")
  if (!states.includes(row.state)) {
    throw new SyncHttpError(409, "request_state", `the request is ${row.state}`)
  }
}

export async function revealMatchesCommit(nonceR: string, row: RequestRow): Promise<boolean> {
  return matchesSasCommit(fromBase64Url(nonceR), row.commit_hash)
}

/** `transcriptHash` the approver must have put in its add-device entry. */
export function expectedTranscriptHash(row: RequestRow, state: RegistryState): Promise<string> {
  return transcriptHash({
    spaceId: state.spaceId,
    genesisHash: state.genesisHash,
    requestId: row.request_id,
    deviceId: row.device_id,
    platform: row.platform as DevicePlatform,
    signPub: row.sign_pub,
    encPub: row.enc_pub,
    commit: row.commit_hash,
    approverDeviceId: row.approver_device_id ?? "",
  })
}

/** What the new device polls. */
export function pendingView(row: RequestRow) {
  return {
    requestId: row.request_id,
    state: row.state,
    expiresAt: row.expires_at,
    approverDeviceId: row.approver_device_id,
    nonceA:
      row.state === "nonce_set" || row.state === "revealed" || row.state === "approved"
        ? row.nonce_a
        : null,
    entrySeq: row.entry_seq,
  }
}

/** What an active device sees in its poll. */
export function approverView(row: RequestRow, viewer: string) {
  const names = JSON.parse(row.names) as SealedName[]
  const isApprover = row.approver_device_id === viewer
  return {
    requestId: row.request_id,
    deviceId: row.device_id,
    platform: row.platform,
    signPub: row.sign_pub,
    encPub: row.enc_pub,
    commit: row.commit_hash,
    name: names.find((name) => name.recipient === viewer) ?? null,
    state: row.state,
    open: isOpenState(row.state),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approverDeviceId: row.approver_device_id,
    nonceR:
      isApprover && (row.state === "revealed" || row.state === "approved") ? row.nonce_r : null,
    entrySeq: row.entry_seq,
  }
}
