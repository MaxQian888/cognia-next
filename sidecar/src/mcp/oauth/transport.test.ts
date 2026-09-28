import assert from "node:assert/strict"
import { test } from "node:test"

import { FakeOAuthTransport } from "../../../test-support/oauth-transport.ts"
import { buildProvider } from "./provider.ts"
import { buildTransport, isUnauthorized, loadSdk } from "./transport.ts"
import type { OAuthSdk, TransportOptions } from "./types.ts"

test("remote transports receive the same guarded fetch, headers, provider and redirect policy", () => {
  const captured: { kind: string; url: URL; options?: TransportOptions }[] = []
  const sdk: OAuthSdk = {
    Client: class {
      async connect() {}
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      constructor(url: URL, options?: TransportOptions) {
        super()
        captured.push({ kind: "http", url, options })
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {
      constructor(url: URL, options?: TransportOptions) {
        super()
        captured.push({ kind: "sse", url, options })
      }
    },
  }
  const provider = buildProvider({}, { redirectUrl: "http://127.0.0.1/callback" })
  const guardedFetch = async () => new Response("ok")
  for (const transport of ["http", "sse"]) {
    buildTransport(
      sdk,
      { transport, config: { url: "https://mcp.example/rpc", headers: { "x-client": "test" } } },
      provider,
      guardedFetch
    )
  }
  assert.deepEqual(
    captured.map(({ kind }) => kind),
    ["http", "sse"]
  )
  for (const { url, options } of captured) {
    assert.equal(url.href, "https://mcp.example/rpc")
    assert.equal(options?.fetch, guardedFetch)
    assert.equal(options?.authProvider, provider)
    assert.deepEqual(options?.requestInit, { headers: { "x-client": "test" }, redirect: "error" })
  }
})

test("SDK loading stays lazy and exposes both remote transport constructors", async () => {
  const sdk = await loadSdk()
  assert.equal(typeof sdk.Client, "function")
  assert.equal(typeof sdk.StreamableHTTPClientTransport, "function")
  assert.equal(typeof sdk.SSEClientTransport, "function")
  assert.equal(isUnauthorized({ name: "UnauthorizedError" }), true)
  assert.equal(isUnauthorized(new Error("unauthorized")), true)
  assert.equal(isUnauthorized(new Error("network unavailable")), false)
})
