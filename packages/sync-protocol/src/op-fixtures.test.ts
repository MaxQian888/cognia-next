/**
 * Frozen op-log vectors (fixtures/v1-ops.json). A failure means the op wire
 * format or merge rules changed: ops already in a space would stop decrypting,
 * verifying or merging the same way. Fix the code; never regenerate the file.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { fromBase64Url } from "./bytes"
import { importEcdsaPublicKey } from "./crypto"
import { compareHlc, encodeHlc, parseHlc, receiveHlc, sendHlc } from "./hlc"
import { mergeDelete, mergeUpsert } from "./merge"
import {
  canonicalFields,
  decryptOpPayload,
  opAad,
  opKey,
  opSigningBytes,
  parseOp,
  verifyOpSignature,
} from "./ops"
import { padmeLength } from "./padding"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OPS: any = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "v1-ops.json"), "utf8")
)
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex")

describe("protocol v1 op-log fixtures", () => {
  it("encodes clocks so string order is clock order", () => {
    const encoded = OPS.hlc.ordered.map(
      ({ clock, encoded: frozen }: { clock: never; encoded: string }) => {
        expect(encodeHlc(clock)).toBe(frozen)
        expect(parseHlc(frozen)).toEqual(clock)
        return frozen
      }
    )
    for (let i = 1; i < encoded.length; i++)
      expect(compareHlc(encoded[i - 1], encoded[i])).toBeLessThan(0)
  })

  it("advances clocks on send and receive", () => {
    for (const { last, now, deviceId, expected } of OPS.hlc.send)
      expect(sendHlc(last, now, deviceId)).toEqual(expected)
    for (const { local, remote, now, expected } of OPS.hlc.receive)
      expect(receiveHlc(local, remote, now)).toEqual(expected)
  })

  it("pads to the frozen buckets and encodes fields canonically", () => {
    for (const { length, bucket } of OPS.padding) expect(padmeLength(length)).toBe(bucket)
    expect(hex(canonicalFields(OPS.canonical.values))).toBe(OPS.canonical.hex)
  })

  it("opens and verifies the frozen op", async () => {
    const { spaceId, epochKey, opKey: frozenKey, signPub, payload, aad, signingBytes } = OPS.sealed
    const op = parseOp(OPS.sealed.op)
    const key = await opKey(bytes(epochKey), spaceId)
    expect(hex(key)).toBe(frozenKey)
    expect(hex(opAad(spaceId, op))).toBe(aad)
    const { sig: _sig, ...unsigned } = op
    expect(hex(opSigningBytes(spaceId, unsigned))).toBe(signingBytes)
    expect(await decryptOpPayload(key, spaceId, op)).toEqual(payload)
    const publicKey = await importEcdsaPublicKey(fromBase64Url(signPub))
    expect(await verifyOpSignature(publicKey, spaceId, op)).toBe(true)
  })

  it("merges to the frozen outcomes", () => {
    for (const { exists, clocks, incoming, expected } of OPS.merge.upserts)
      expect(mergeUpsert(exists, clocks, incoming)).toEqual(expected)
    for (const { exists, clocks, at, expected } of OPS.merge.deletes)
      expect(mergeDelete(exists, clocks, at)).toEqual(expected)
  })
})
