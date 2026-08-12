import assert from "node:assert/strict"
import test from "node:test"

import { encodeClientTextFrame } from "./unix-websocket.mjs"

function decodeClientFrame(input) {
  const encoded = encodeClientTextFrame(input)
  assert.equal(encoded[0], 0x81)
  assert.equal((encoded[1] & 0x80) !== 0, true)
  const lengthMarker = encoded[1] & 0x7f
  const headerLength = lengthMarker === 126 ? 4 : lengthMarker === 127 ? 10 : 2
  const payloadLength =
    lengthMarker === 126
      ? encoded.readUInt16BE(2)
      : lengthMarker === 127
        ? Number(encoded.readBigUInt64BE(2))
        : lengthMarker
  const mask = encoded.subarray(headerLength, headerLength + 4)
  const payload = Buffer.from(encoded.subarray(headerLength + 4))
  assert.equal(payload.length, payloadLength)
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return payload.toString("utf8")
}

test("client text frames are final, masked, and decode to the original JSON", () => {
  const input = JSON.stringify({ id: 1, method: "initialize" })
  assert.equal(decodeClientFrame(input), input)
})

test("client text frames encode extended payload lengths", () => {
  for (const length of [126, 65_536]) {
    const input = "x".repeat(length)
    assert.equal(decodeClientFrame(input), input)
  }
})
