import assert from "node:assert/strict"
import test from "node:test"

import {
  FRAME_HEADER_BYTES,
  decodeMediaFrame,
  encodeMediaFrame,
  protocolEnvelope,
} from "./protocol.mjs"

test("media frame has a fixed versioned binary header", () => {
  const encoded = encodeMediaFrame({
    sequence: 42,
    width: 1280,
    height: 720,
    timestamp: 1_721_234_567_890,
    jpeg: Buffer.from([1, 2, 3]),
  })
  assert.equal(encoded.length, FRAME_HEADER_BYTES + 3)
  assert.deepEqual(decodeMediaFrame(encoded), {
    version: 1,
    codec: "jpeg",
    sequence: 42,
    width: 1280,
    height: 720,
    timestamp: 1_721_234_567_890,
    jpeg: Buffer.from([1, 2, 3]),
  })
})

test("control messages use the v1 JSON envelope", () => {
  assert.deepEqual(protocolEnvelope("page.active", { pageId: "page-1" }, "req-1"), {
    version: 1,
    type: "page.active",
    requestId: "req-1",
    payload: { pageId: "page-1" },
  })
})
