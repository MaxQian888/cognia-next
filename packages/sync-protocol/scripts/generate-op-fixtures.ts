/**
 * Writes fixtures/v1-ops.json: frozen vectors for the op log (protocol §7–9,
 * ADR-0215 phase 3): clock encoding and order, padding buckets, the canonical
 * field encoding, one sealed and signed op, and merge outcomes.
 *
 * Kept apart from v1.json so adding these did not regenerate (and so change)
 * the registry vectors. The same rule holds: do NOT rerun this to make a
 * failing test pass; a mismatch means the wire format changed.
 *
 *   pnpm exec tsx packages/sync-protocol/scripts/generate-op-fixtures.ts
 */

// static-export-exempt: manual Node fixture writer, outside package src exports and app imports.
import { writeFileSync } from "node:fs"
import path from "node:path" // static-export-exempt: manual Node fixture writer resolves its output path; not shipped to clients.
import { fileURLToPath } from "node:url" // static-export-exempt: manual Node fixture writer locates its script directory; not shipped to clients.

import { newEpochKey } from "../src/epoch"
import { encodeHlc, receiveHlc, sendHlc } from "../src/hlc"
import { newDeviceId } from "../src/ids"
import { mergeDelete, mergeUpsert, type RowClocks } from "../src/merge"
import {
  canonicalFields,
  encryptOpPayload,
  opAad,
  opKey,
  opSigningBytes,
  signOp,
  type OpHeader,
  type OpPayload,
} from "../src/ops"
import { padmeLength } from "../src/padding"
import { makeDevice } from "../src/testing/chain"

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v1-ops.json")
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

async function main() {
  const a = newDeviceId()
  const b = newDeviceId()
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const clocks = [
    { ms: 0, c: 0, deviceId: lo },
    { ms: 1, c: 0, deviceId: lo },
    { ms: 1, c: 1, deviceId: lo },
    { ms: 1, c: 1, deviceId: hi },
    { ms: 255, c: 0xffff, deviceId: lo },
    { ms: 2 ** 48 - 1, c: 0, deviceId: lo },
  ]
  const hlc = {
    ordered: clocks.map((clock) => ({ clock, encoded: encodeHlc(clock) })),
    send: [
      { last: null, now: 500, deviceId: lo },
      { last: { ms: 500, c: 0 }, now: 500, deviceId: lo },
      { last: { ms: 2000, c: 0xffff }, now: 500, deviceId: lo },
    ].map((input) => ({ ...input, expected: sendHlc(input.last, input.now, input.deviceId) })),
    receive: [
      { local: { ms: 100, c: 0 }, remote: { ms: 200, c: 3 }, now: 150 },
      { local: { ms: 300, c: 0 }, remote: { ms: 200, c: 3 }, now: 150 },
      { local: { ms: 1000, c: 1 }, remote: { ms: 1000 + 300_001, c: 0 }, now: 1000 },
    ].map((input) => ({ ...input, expected: receiveHlc(input.local, input.remote, input.now) })),
  }

  const padding = [0, 1, 2, 9, 100, 1000, 1025, 65_537, 1_000_000].map((length) => ({
    length,
    bucket: padmeLength(length),
  }))

  const canonical = {
    values: ["sessions", 42, ""],
    hex: hex(canonicalFields(["sessions", 42, ""])),
  }

  const spaceId = "s".repeat(43)
  const device = await makeDevice("MacBook", "desktop")
  const epochKey = newEpochKey()
  const key = await opKey(epochKey, spaceId)
  const fieldClock = encodeHlc({ ms: 1_790_000_000_000, c: 2, deviceId: device.deviceId })
  const payload: OpPayload = {
    t: "sessions",
    id: "ses_01",
    k: "upsert",
    f: { title: ["Plan the trip", fieldClock], pinned: [true, fieldClock] },
  }
  const header: OpHeader = {
    deviceId: device.deviceId,
    deviceSeq: 7,
    hlc: { ms: 1_790_000_000_000, c: 2 },
    epoch: 3,
    schemaVer: 1,
    cls: "c",
  }
  const { nonce, ct } = await encryptOpPayload(key, spaceId, header, payload)
  const op = await signOp(device.sign.privateKey, spaceId, { ...header, nonce, ct })
  const sealed = {
    spaceId,
    epochKey: hex(epochKey),
    opKey: hex(key),
    signPub: device.signPub,
    payload,
    aad: hex(opAad(spaceId, header)),
    signingBytes: hex(opSigningBytes(spaceId, { ...header, nonce, ct })),
    op,
  }

  const t = (ms: number, deviceId = lo) => encodeHlc({ ms, c: 0, deviceId })
  const upserts: {
    exists: boolean
    clocks?: RowClocks
    incoming: Record<string, [unknown, string]>
  }[] = [
    { exists: false, incoming: { a: [1, t(1)] } },
    { exists: true, clocks: { fields: { a: t(5) } }, incoming: { a: [2, t(4)], b: [3, t(6)] } },
    { exists: true, clocks: { fields: { a: t(5, hi) } }, incoming: { a: [2, t(5, lo)] } },
    { exists: false, clocks: { fields: {}, tombstone: t(10) }, incoming: { a: [1, t(9)] } },
    {
      exists: false,
      clocks: { fields: {}, tombstone: t(10) },
      incoming: { a: [1, t(3)], b: [2, t(11)] },
    },
  ]
  const deletes: { exists: boolean; clocks?: RowClocks; at: string }[] = [
    { exists: true, clocks: { fields: { a: t(1) } }, at: t(5) },
    { exists: true, clocks: { fields: { a: t(1), b: t(9) } }, at: t(5) },
    { exists: false, clocks: { fields: {}, tombstone: t(5) }, at: t(5) },
  ]
  const merge = {
    upserts: upserts.map((input) => ({
      ...input,
      expected: mergeUpsert(input.exists, input.clocks, input.incoming),
    })),
    deletes: deletes.map((input) => ({
      ...input,
      expected: mergeDelete(input.exists, input.clocks, input.at),
    })),
  }

  const fixtures = {
    "//": "Account Sync Protocol v1 op-log vectors. Frozen: never regenerate to fix a test (see scripts/generate-op-fixtures.ts).",
    hlc,
    padding,
    canonical,
    sealed,
    merge,
  }
  writeFileSync(OUT, `${JSON.stringify(fixtures, null, 2)}\n`)
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`)
}

await main()
