import assert from "node:assert/strict"
import { test } from "node:test"
import { gzipSync, gunzipSync } from "node:zlib"
import worker from "./docs-search-worker.mjs"

test("serves the complete compressed search JSON with response encoding", async (t) => {
  const NativeResponse = Response
  let responseInit
  t.mock.method(globalThis, "Response", function (body, init) {
    responseInit = init
    return new NativeResponse(body, init)
  })
  const data = Buffer.from(JSON.stringify({ zh: "文档", en: "documentation" }))
  let assetRequest
  const response = await worker.fetch(new Request("https://docs.test/api/search?locale=zh"), {
    ASSETS: {
      fetch: async (request) => {
        assetRequest = request
        return new Response(gzipSync(data))
      },
    },
  })
  assert.equal(assetRequest.url, "https://docs.test/api/search-index.json.gz")
  assert.equal(response.headers.get("Content-Encoding"), "gzip")
  assert.equal(responseInit.encodeBody, "manual")
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8")
  assert.deepEqual(gunzipSync(Buffer.from(await response.arrayBuffer())), data)
})

test("keeps document pages on the static asset service", async () => {
  const request = new Request("https://docs.test/zh/docs")
  const asset = new Response("document")
  const response = await worker.fetch(request, {
    ASSETS: {
      fetch: async (received) => {
        assert.equal(received, request)
        return asset
      },
    },
  })
  assert.equal(response, asset)
})

test("handles HEAD, unsupported methods, and missing search assets", async () => {
  const env = { ASSETS: { fetch: async () => new Response(gzipSync("{}")) } }
  const head = await worker.fetch(
    new Request("https://docs.test/api/search/", { method: "HEAD" }),
    env
  )
  assert.equal(head.headers.get("Content-Encoding"), "gzip")
  assert.equal(await head.text(), "")
  const post = await worker.fetch(
    new Request("https://docs.test/api/search", { method: "POST" }),
    env
  )
  assert.equal(post.status, 405)
  assert.equal(post.headers.get("Allow"), "GET, HEAD")
  const missing = new Response("missing", { status: 404 })
  assert.equal(
    await worker.fetch(new Request("https://docs.test/api/search"), {
      ASSETS: { fetch: async () => missing },
    }),
    missing
  )
})
