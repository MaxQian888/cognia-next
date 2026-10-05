/**
 * Ops (protocol §7): one encrypted, signed change to one row.
 *
 * The server sees only the envelope: which device, its sequence number, the
 * clock, the epoch, the client's sync schema version and a coarse class. The
 * table, the row id, the field names and the values travel inside `ct`,
 * padded (§7.4) under the epoch's `op` subkey.
 */

import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8, concatBytes } from "./bytes"
import { aesGcmDecrypt, aesGcmEncrypt, ecdsaSign, ecdsaVerifyWithKey } from "./crypto"
import { epochSubkey } from "./epoch"
import { isEncodedHlc, type HlcTime } from "./hlc"
import { isDeviceId } from "./ids"
import { labelled } from "./labels"
import { MAX_OP_NAME_CHARS, MAX_OP_PLAINTEXT_BYTES } from "./limits"
import { pad, unpad } from "./padding"

/** content, settings, secrets, crdt, append-only (ADR §7). */
export const OP_CLASSES = ["c", "s", "k", "x", "a"] as const
export type OpClass = (typeof OP_CLASSES)[number]

export interface OpHeader {
  deviceId: string
  /** Gapless per device, from 1. */
  deviceSeq: number
  /** The op's clock: the latest clock among the fields it carries. */
  hlc: HlcTime
  epoch: number
  /** The writer's sync schema version (§9 schema skew). */
  schemaVer: number
  cls: OpClass
}

export interface Op extends OpHeader {
  nonce: string
  ct: string
  sig: string
}

/** A field value with the clock of the write that set it. */
export type ClockedValue = [value: unknown, hlc: string]

export type OpPayload =
  | {
      t: string
      id: string
      k: "upsert"
      /** The fields this op writes. */
      f: Record<string, ClockedValue>
      /** Fields from a newer schema the writer kept but does not know (§9). */
      u?: Record<string, ClockedValue>
    }
  | { t: string; id: string; k: "delete"; at: string }

export class OpError extends Error {
  readonly code = "bad_op" as const

  constructor(message: string) {
    super(message)
    this.name = "OpError"
  }
}

function u32(length: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, length)
  return out
}

/** `u32-be length ‖ bytes` per field, integers as decimal ASCII (§7.1). */
export function canonicalFields(values: readonly (string | number)[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const value of values) {
    const bytes = utf8(typeof value === "number" ? String(value) : value)
    parts.push(u32(bytes.length), bytes)
  }
  return concatBytes(...parts)
}

export function opAad(spaceId: string, header: OpHeader): Uint8Array {
  return labelled(
    "op",
    canonicalFields([
      spaceId,
      header.cls,
      header.schemaVer,
      header.epoch,
      header.deviceId,
      header.deviceSeq,
    ])
  )
}

/** What the device signs: every envelope field, bound to the space. */
export function opSigningBytes(spaceId: string, op: Omit<Op, "sig">): Uint8Array {
  return labelled(
    "op-sig",
    canonicalFields([
      spaceId,
      op.deviceId,
      op.deviceSeq,
      op.hlc.ms,
      op.hlc.c,
      op.epoch,
      op.schemaVer,
      op.cls,
      op.nonce,
      op.ct,
    ])
  )
}

export function opKey(epochKey: Uint8Array, spaceId: string): Promise<Uint8Array> {
  return epochSubkey(epochKey, spaceId, "op")
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OP_NAME_CHARS
}

function isClockedMap(value: unknown): value is Record<string, ClockedValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([name, entry]) =>
      isName(name) && Array.isArray(entry) && entry.length === 2 && isEncodedHlc(entry[1])
  )
}

/** A decrypted payload, checked for shape. */
export function parseOpPayload(value: unknown): OpPayload {
  const p = value as Partial<Record<string, unknown>> | null
  if (typeof p !== "object" || p === null || !isName(p.t) || !isName(p.id))
    throw new OpError("malformed op payload")
  if (p.k === "upsert") {
    if (!isClockedMap(p.f) || Object.keys(p.f).length === 0)
      throw new OpError("an upsert needs clocked fields")
    if (p.u !== undefined && !isClockedMap(p.u)) throw new OpError("malformed unknown fields")
    return {
      t: p.t,
      id: p.id,
      k: "upsert",
      f: p.f,
      ...(p.u ? { u: p.u as Record<string, ClockedValue> } : {}),
    }
  }
  if (p.k === "delete") {
    if (!isEncodedHlc(p.at)) throw new OpError("a delete needs a clock")
    return { t: p.t, id: p.id, k: "delete", at: p.at }
  }
  throw new OpError("unknown op kind")
}

export async function encryptOpPayload(
  key: Uint8Array,
  spaceId: string,
  header: OpHeader,
  payload: OpPayload
): Promise<{ nonce: string; ct: string }> {
  const plaintext = utf8(JSON.stringify(payload))
  if (plaintext.length > MAX_OP_PLAINTEXT_BYTES) throw new OpError("the op is too large")
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(key, nonce, pad(plaintext), opAad(spaceId, header))
  return { nonce: toBase64Url(nonce), ct: toBase64Url(ct) }
}

export async function decryptOpPayload(
  key: Uint8Array,
  spaceId: string,
  op: Op
): Promise<OpPayload> {
  let plaintext: Uint8Array
  try {
    plaintext = unpad(
      await aesGcmDecrypt(key, fromBase64Url(op.nonce), fromBase64Url(op.ct), opAad(spaceId, op))
    )
  } catch {
    throw new OpError("the op does not decrypt")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new OpError("the op payload is not JSON")
  }
  return parseOpPayload(parsed)
}

export async function signOp(
  privateKey: CryptoKey,
  spaceId: string,
  unsigned: Omit<Op, "sig">
): Promise<Op> {
  const sig = await ecdsaSign(privateKey, opSigningBytes(spaceId, unsigned))
  return { ...unsigned, sig: toBase64Url(sig) }
}

export async function verifyOpSignature(
  signKey: CryptoKey,
  spaceId: string,
  op: Op
): Promise<boolean> {
  let sig: Uint8Array
  try {
    sig = fromBase64Url(op.sig)
  } catch {
    return false
  }
  const { sig: _sig, ...unsigned } = op
  return ecdsaVerifyWithKey(signKey, sig, opSigningBytes(spaceId, unsigned))
}

const B64URL = /^[A-Za-z0-9_-]+$/

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/** An op envelope from the wire, checked for shape (not signature). */
export function parseOp(value: unknown): Op {
  const o = value as Partial<Record<string, unknown>> | null
  if (typeof o !== "object" || o === null) throw new OpError("malformed op")
  const hlc = o.hlc as Partial<HlcTime> | undefined
  if (
    !isDeviceId(o.deviceId) ||
    !isPositiveInt(o.deviceSeq) ||
    typeof hlc !== "object" ||
    hlc === null ||
    !Number.isSafeInteger(hlc.ms) ||
    (hlc.ms as number) < 0 ||
    !Number.isInteger(hlc.c) ||
    (hlc.c as number) < 0 ||
    (hlc.c as number) > 0xffff ||
    !isPositiveInt(o.epoch) ||
    !isPositiveInt(o.schemaVer) ||
    !(OP_CLASSES as readonly unknown[]).includes(o.cls) ||
    typeof o.nonce !== "string" ||
    o.nonce.length !== 16 ||
    !B64URL.test(o.nonce) ||
    typeof o.ct !== "string" ||
    !B64URL.test(o.ct) ||
    typeof o.sig !== "string" ||
    !B64URL.test(o.sig)
  ) {
    throw new OpError("malformed op")
  }
  return {
    deviceId: o.deviceId,
    deviceSeq: o.deviceSeq,
    hlc: { ms: hlc.ms as number, c: hlc.c as number },
    epoch: o.epoch,
    schemaVer: o.schemaVer,
    cls: o.cls as OpClass,
    nonce: o.nonce,
    ct: o.ct,
    sig: o.sig,
  }
}
