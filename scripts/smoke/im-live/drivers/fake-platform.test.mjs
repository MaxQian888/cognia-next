// The fake platform is the only thing standing between every driver test and a
// real service, so its own routing has to be pinned: a `:param` route that
// silently stops matching would make a driver test pass against a 404 body.

import assert from "node:assert/strict"
import test from "node:test"

import { withFakePlatform } from "./fake-platform.mjs"

const get = (baseUrl, path, init) => fetch(`${baseUrl}${path}`, init)

test("routes an exact method + pathname and records the call", async () => {
  await withFakePlatform(
    { "GET /ok": ({ query }) => ({ json: { seen: query.q } }) },
    async ({ baseUrl, calls, callsTo }) => {
      const res = await get(baseUrl, "/ok?q=hello")
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { seen: "hello" })
      assert.equal(calls.length, 1)
      assert.deepEqual(callsTo("GET /ok")[0].query, { q: "hello" })
    }
  )
})

test("matches :param segments and decodes them", async () => {
  await withFakePlatform(
    { "DELETE /channels/:id/messages/:messageId": ({ params }) => ({ json: params }) },
    async ({ baseUrl }) => {
      const res = await get(baseUrl, "/channels/c%201/messages/m2", { method: "DELETE" })
      assert.deepEqual(await res.json(), { id: "c 1", messageId: "m2" })
    }
  )
})

test("a pattern of a different length or method does not match", async () => {
  await withFakePlatform(
    { "GET /a/:one": () => ({ json: { matched: true } }) },
    async ({ baseUrl }) => {
      assert.equal((await get(baseUrl, "/a/b/c")).status, 404)
      assert.equal((await get(baseUrl, "/a/b", { method: "POST" })).status, 404)
    }
  )
})

test("an unmatched request answers 404 and is still recorded", async () => {
  await withFakePlatform({}, async ({ baseUrl, callsTo }) => {
    const res = await get(baseUrl, "/nope")
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /no fake route for GET \/nope/)
    // Recorded, so a test can assert a driver did NOT call something.
    assert.equal(callsTo("GET /nope").length, 1)
  })
})

test("parses a JSON body, and keeps a non-JSON one as text", async () => {
  await withFakePlatform(
    { "POST /echo": ({ body }) => ({ json: { body } }) },
    async ({ baseUrl }) => {
      const json = await (
        await get(baseUrl, "/echo", { method: "POST", body: JSON.stringify({ a: 1 }) })
      ).json()
      assert.deepEqual(json.body, { a: 1 })
      const text = await (await get(baseUrl, "/echo", { method: "POST", body: "not json" })).json()
      assert.equal(text.body, "not json")
    }
  )
})

test("honours status, text and an empty response", async () => {
  await withFakePlatform(
    {
      "GET /forbidden": () => ({ status: 403, json: { error: "missing_scope" } }),
      "GET /page": () => ({ text: "<html>", contentType: "text/html" }),
      "GET /empty": () => ({}),
    },
    async ({ baseUrl }) => {
      const forbidden = await get(baseUrl, "/forbidden")
      assert.equal(forbidden.status, 403)
      assert.deepEqual(await forbidden.json(), { error: "missing_scope" })

      const page = await get(baseUrl, "/page")
      assert.equal(page.headers.get("content-type"), "text/html")
      assert.equal(await page.text(), "<html>")

      assert.equal((await get(baseUrl, "/empty")).status, 204)
    }
  )
})

test("closes the server even when the body throws", async () => {
  let baseUrl
  await assert.rejects(
    withFakePlatform({}, async (ctx) => {
      baseUrl = ctx.baseUrl
      throw new Error("boom")
    }),
    /boom/
  )
  await assert.rejects(fetch(`${baseUrl}/anything`))
})
