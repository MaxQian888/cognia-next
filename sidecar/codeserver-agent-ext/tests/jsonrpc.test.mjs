import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ContentLengthDecoder,
  JSON_RPC_VERSION,
  MAX_FRAME_BYTES,
  brokerChallengeRequest,
  brokerHelloRequest,
  errorResponse,
  eventNotification,
  requestMessage,
  responseMessage,
  serializeContentLength,
  validateNegotiatedHello,
} from "../src/jsonrpc.mjs"

test("ContentLengthDecoder accepts fragmented and coalesced frames", () => {
  const decoder = new ContentLengthDecoder()
  const first = serializeContentLength(requestMessage(1, "editor/readActive", {}))
  const second = serializeContentLength(eventNotification("documentSaved", { path: "/a.ts" }))

  assert.deepEqual(decoder.push(first.subarray(0, 9)), [])
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(9), second])), [
    {
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "editor/readActive",
      params: {},
    },
    {
      jsonrpc: JSON_RPC_VERSION,
      method: "cognia/event",
      params: { name: "documentSaved", payload: { path: "/a.ts" } },
    },
  ])
})

test("ContentLengthDecoder rejects malformed and oversized headers", () => {
  const malformed = new ContentLengthDecoder()
  assert.throws(
    () => malformed.push(Buffer.from("Content-Type: application/json\r\n\r\n{}")),
    /missing Content-Length/i
  )

  const oversized = new ContentLengthDecoder()
  assert.throws(
    () => oversized.push(Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`, "ascii")),
    /exceeds/i
  )
})

test("ContentLengthDecoder rejects invalid JSON without losing framing state", () => {
  const decoder = new ContentLengthDecoder()
  assert.throws(
    () => decoder.push(Buffer.from("Content-Length: 1\r\n\r\n{", "ascii")),
    /invalid JSON/i
  )
})

test("JSON-RPC helpers emit standard requests, results, and structured errors", () => {
  assert.deepEqual(requestMessage(7, "provider/invoke", { providerId: "hover" }), {
    jsonrpc: "2.0",
    id: 7,
    method: "provider/invoke",
    params: { providerId: "hover" },
  })
  assert.deepEqual(responseMessage(7, { value: 1 }), {
    jsonrpc: "2.0",
    id: 7,
    result: { value: 1 },
  })
  assert.deepEqual(errorResponse(7, -32004, "permission denied", { permission: "editor:read" }), {
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32004,
      message: "permission denied",
      data: { permission: "editor:read" },
    },
  })
})

test("broker hello advertises the pinned API and capability catalog", () => {
  assert.deepEqual(brokerChallengeRequest("token-id"), {
    jsonrpc: "2.0",
    id: "challenge",
    method: "cognia/auth/challenge",
    params: { tokenId: "token-id" },
  })
  assert.deepEqual(
    brokerHelloRequest({
      tokenId: "token-id",
      proof: "proof",
      catalogHash: "sha256:catalog",
      hostId: "local",
      workspace: "/work",
    }),
    {
      jsonrpc: "2.0",
      id: "hello",
      method: "cognia/hello",
      params: {
        tokenId: "token-id",
        proof: "proof",
        protocolVersions: ["1.0", "0.2"],
        codeApiVersion: "1.128.0",
        catalogHash: "sha256:catalog",
        hostId: "local",
        workspace: "/work",
        capabilities: [
          "cancel",
          "progress",
          "structured-errors",
          "content-handles",
          "contribution-transactions",
        ],
      },
    }
  )
})

test("negotiated hello requires pinned versions and mandatory capabilities", () => {
  const result = {
    protocolVersion: "1.0",
    codeApiVersion: "1.128.0",
    catalogHash: "sha256:catalog",
    generation: 3,
    capabilities: ["structured-errors", "content-handles", "contribution-transactions"],
  }
  assert.equal(validateNegotiatedHello(result, "sha256:catalog").generation, 3)
  assert.throws(
    () =>
      validateNegotiatedHello({ ...result, capabilities: ["structured-errors"] }, "sha256:catalog"),
    /IDE_BROKER_NEGOTIATION_INVALID/
  )
})
