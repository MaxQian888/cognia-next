import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import { ContentHandleClient } from "../src/content-handles.mjs"

function handle(bytes, id = "handle-1") {
  return {
    $type: "ContentHandle",
    id,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "application/octet-stream",
    expiresAtMs: Date.now() + 30_000,
  }
}

test("uploads raw bytes with credentials in headers and never in the URL", async () => {
  const bytes = Uint8Array.from([1, 2, 3])
  const calls = []
  const client = new ContentHandleClient({
    port: 4312,
    credential: "id.secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(handle(bytes)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  await client.upload(
    {
      pluginId: "acme",
      id: "cognia.acme.fs",
      permission: "filesystem:write",
    },
    bytes
  )
  assert.equal(calls[0].url, "http://127.0.0.1:4312/v1/content")
  assert.equal(calls[0].init.headers.authorization, "Bearer id.secret")
  assert.equal(calls[0].init.headers["x-cognia-plugin-id"], "acme")
  assert.deepEqual(Buffer.from(calls[0].init.body), Buffer.from(bytes))
  assert.doesNotMatch(calls[0].url, /secret/)
})

test("downloads one-shot content and verifies size and digest", async () => {
  const bytes = Uint8Array.from([4, 5, 6])
  const contentHandle = handle(bytes, "opaque")
  const client = new ContentHandleClient({
    port: 4312,
    credential: "id.secret",
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  })

  assert.deepEqual(
    await client.download({ pluginId: "acme", id: "cognia.acme.fs" }, contentHandle),
    bytes
  )
})

test("fails closed on altered content", async () => {
  const expected = Uint8Array.from([1, 2, 3])
  const client = new ContentHandleClient({
    port: 4312,
    credential: "id.secret",
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 4])),
  })

  await assert.rejects(
    client.download({ pluginId: "acme", id: "cognia.acme.fs" }, handle(expected)),
    /IDE_CONTENT_HANDLE_INTEGRITY_FAILED/
  )
})

test("reads a rotating bearer per request and refuses while disconnected", async () => {
  const bytes = Uint8Array.from([7])
  let bearer = "session-1.mac-1"
  const seen = []
  const client = new ContentHandleClient({
    port: 4312,
    credential: () => bearer,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.authorization)
      return new Response(JSON.stringify(handle(bytes)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const provider = { pluginId: "acme", id: "cognia.acme.fs" }
  await client.upload(provider, bytes)
  bearer = "session-2.mac-2"
  await client.upload(provider, bytes)
  assert.deepEqual(seen, ["Bearer session-1.mac-1", "Bearer session-2.mac-2"])

  bearer = null
  await assert.rejects(client.upload(provider, bytes), /IDE_CONTENT_CREDENTIAL_UNAVAILABLE/)
  assert.equal(seen.length, 2)
})
