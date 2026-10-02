// node --test services/signaling-server/worker/tests/synthetic-room.test.mjs
//
// Pins the portable helpers to the byte layout of the original Buffer-based
// implementation that `integration.mjs` carried before the extraction, and
// proves a generated proof verifies under WebCrypto. The legacy encoder is
// inlined on purpose: it is the reference, not shared code.

import assert from "node:assert/strict"
import { webcrypto } from "node:crypto"
import { test } from "node:test"

import {
  base64UrlToBytes,
  bytesToBase64Url,
  createRoom,
  deriveRoomId,
  descriptorBytes,
  encodeFields,
  proofBytes,
  randomBase64Url,
  subscribeFrame,
  verifyProof,
} from "./synthetic-room.mjs"

// --- legacy reference (verbatim from integration.mjs before extraction) -----

function legacyEncodeFields(fields) {
  const parts = []
  for (const value of fields) {
    const field = Buffer.from(String(value), "utf8")
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.byteLength)
    parts.push(length, field)
  }
  return Buffer.concat(parts)
}

function legacyBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url")
}

// ---------------------------------------------------------------------------

const SAMPLE_FIELDS = [
  [],
  [""],
  [2, "nonce", "desk", "mob", 1_800_000_000_000],
  ["ünïcødé", "漢字", "emoji 🚀", "\u0000ctl", "a".repeat(70_000)],
  [0, -1, 1.5, "line\nbreak", "lone \ud800 surrogate"],
]

test("encodeFields is byte-for-byte identical to the Buffer implementation", () => {
  for (const fields of SAMPLE_FIELDS) {
    const portable = encodeFields(fields)
    assert.ok(portable instanceof Uint8Array)
    assert.deepEqual(Buffer.from(portable), legacyEncodeFields(fields))
  }
})

test("base64url matches Buffer's unpadded base64url for every length", () => {
  for (let length = 0; length <= 70; length += 1) {
    const bytes = webcrypto.getRandomValues(new Uint8Array(length))
    const encoded = bytesToBase64Url(bytes)
    assert.equal(encoded, legacyBase64Url(bytes))
    assert.deepEqual(base64UrlToBytes(encoded), bytes)
  }
  const large = new Uint8Array(200_000).map((_, index) => index % 256)
  assert.equal(bytesToBase64Url(large), legacyBase64Url(large))
  assert.equal(base64UrlToBytes("not base64!"), null)
  assert.equal(base64UrlToBytes("abcde"), null)
})

test("randomBase64Url yields fresh values of the requested byte length", () => {
  const first = randomBase64Url(16)
  const second = randomBase64Url(16)
  assert.notEqual(first, second)
  assert.equal(base64UrlToBytes(first).byteLength, 16)
})

test("createRoom derives the room id exactly like the legacy helper", async () => {
  const now = 1_790_000_000_000
  const room = await createRoom({ now, ttlMs: 90_000 })
  const { descriptor } = room
  assert.deepEqual(Object.keys(descriptor), [
    "v",
    "roomId",
    "roomNonce",
    "desktopSigningKey",
    "mobileSigningKey",
    "notAfter",
  ])
  assert.equal(descriptor.v, 2)
  assert.equal(descriptor.notAfter, now + 90_000)
  assert.equal(base64UrlToBytes(descriptor.roomNonce).byteLength, 16)
  assert.equal(base64UrlToBytes(descriptor.desktopSigningKey).byteLength, 65)
  const legacyDigest = await webcrypto.subtle.digest(
    "SHA-256",
    legacyEncodeFields([
      2,
      descriptor.roomNonce,
      descriptor.desktopSigningKey,
      descriptor.mobileSigningKey,
      descriptor.notAfter,
    ])
  )
  assert.equal(descriptor.roomId, legacyBase64Url(new Uint8Array(legacyDigest)))
  assert.equal(await deriveRoomId(descriptor), descriptor.roomId)
  assert.deepEqual(
    Buffer.from(descriptorBytes(descriptor)),
    legacyEncodeFields([
      2,
      descriptor.roomNonce,
      descriptor.desktopSigningKey,
      descriptor.mobileSigningKey,
      descriptor.notAfter,
    ])
  )

  const defaults = await createRoom()
  assert.ok(Math.abs(defaults.descriptor.notAfter - (Date.now() + 60_000)) < 5_000)
})

test("every room gets fresh keys and nonce", async () => {
  const [a, b] = await Promise.all([createRoom(), createRoom()])
  assert.notEqual(a.descriptor.roomId, b.descriptor.roomId)
  assert.notEqual(a.descriptor.roomNonce, b.descriptor.roomNonce)
  assert.notEqual(a.descriptor.desktopSigningKey, b.descriptor.desktopSigningKey)
})

test("a subscribe proof is challenge-bound and verifies with WebCrypto", async () => {
  const room = await createRoom()
  for (const role of ["desktop", "mobile"]) {
    const frame = await subscribeFrame(room, role, "challenge-xyz", { now: 1_790_000_000_123 })
    assert.equal(frame.kind, "subscribe")
    assert.equal(frame.descriptor, room.descriptor)
    const { proof } = frame
    assert.equal(proof.role, role)
    assert.equal(proof.challenge, "challenge-xyz")
    assert.equal(proof.issuedAt, 1_790_000_000_123)
    assert.equal(base64UrlToBytes(proof.ecdhPublicKey).byteLength, 65)

    // Independent verification with the raw public key and legacy encoding.
    const publicKey = await webcrypto.subtle.importKey(
      "raw",
      base64UrlToBytes(
        role === "desktop" ? room.descriptor.desktopSigningKey : room.descriptor.mobileSigningKey
      ),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    )
    const legacyBytes = legacyEncodeFields([
      proof.v,
      proof.roomId,
      proof.role,
      proof.sessionId,
      proof.epoch,
      proof.issuedAt,
      proof.challenge,
      proof.ecdhPublicKey,
    ])
    assert.deepEqual(Buffer.from(proofBytes(proof)), legacyBytes)
    assert.equal(
      await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        base64UrlToBytes(proof.signature),
        legacyBytes
      ),
      true
    )
    assert.equal(await verifyProof(room.descriptor, proof), true)
  }
})

test("tampered proofs and foreign rooms fail verification", async () => {
  const room = await createRoom()
  const other = await createRoom()
  const frame = await subscribeFrame(room, "mobile", "c1")
  assert.equal(await verifyProof(room.descriptor, { ...frame.proof, epoch: "tampered" }), false)
  assert.equal(await verifyProof(room.descriptor, { ...frame.proof, challenge: "c2" }), false)
  assert.equal(await verifyProof(other.descriptor, frame.proof), false)
  assert.equal(await verifyProof(room.descriptor, { ...frame.proof, role: "desktop" }), false)
  assert.equal(await verifyProof(room.descriptor, { ...frame.proof, signature: "!!" }), false)
  const forged = await subscribeFrame(other, "mobile", "c1")
  assert.equal(
    await verifyProof(room.descriptor, { ...frame.proof, signature: forged.proof.signature }),
    false
  )
})

test("each subscribe mints a fresh session, epoch and ECDH key", async () => {
  const room = await createRoom()
  const first = await subscribeFrame(room, "desktop", "c")
  const second = await subscribeFrame(room, "desktop", "c")
  assert.notEqual(first.proof.sessionId, second.proof.sessionId)
  assert.notEqual(first.proof.epoch, second.proof.epoch)
  assert.notEqual(first.proof.ecdhPublicKey, second.proof.ecdhPublicKey)
})

test("the module uses no Node-only APIs", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./synthetic-room.mjs", import.meta.url), "utf8")
  // Comments may name the forbidden APIs; only code is checked.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
  assert.doesNotMatch(code, /\bBuffer\b/)
  assert.doesNotMatch(code, /from\s+["']node:/)
  assert.doesNotMatch(code, /\brequire\(/)
  assert.doesNotMatch(code, /\bprocess\./)
})
