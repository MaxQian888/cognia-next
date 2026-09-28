import { FakeOAuthTransport } from "../../../test-support/oauth-transport.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { runFlow } from "../../../mcp-oauth-helper.mjs"

test("runFlow rejects stdio servers as unsupported", async () => {
  const out = await runFlow({ server: { transport: "stdio", config: {} }, mode: "authenticate" })
  assert.equal(out.result.ok, false)
  assert.equal(out.result.status, "unsupported")
})

test("runFlow blocks a private endpoint before starting the callback server", async () => {
  let callbackStarted = false
  const out = await runFlow(
    { server: { transport: "http", config: { url: "https://127.0.0.1/mcp" } } },
    {
      startCallbackServer: async () => {
        callbackStarted = true
        throw new Error("must not run")
      },
    }
  )
  assert.equal(out.result.ok, false)
  assert.match(out.result.message, /egress blocked/)
  assert.equal(callbackStarted, false)
})

test("runFlow returns authorized when the stored token already connects", async () => {
  // Inject fakes so no sockets / browser are touched.
  const fakeSdk = {
    Client: class {
      async connect() {
        return undefined
      }
      async close() {
        return undefined
      }
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      finishAuth: (code: string) => Promise<void>
      constructor() {
        super()
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  const callback = {
    redirectUrl: "http://127.0.0.1:1/callback",
    waitForCode: async () => ({ code: "x" }),
    close: () => undefined,
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x/mcp" } },
      entry: { tokens: { access_token: "t", token_type: "Bearer" } },
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => callback,
      openBrowser: () => undefined,
      onAuthUrl: () => undefined,
    }
  )
  assert.equal(out.result.ok, true)
  assert.equal(out.result.status, "authorized")
})

test("runFlow completes the authorization-code exchange on UnauthorizedError", async () => {
  let connects = 0
  const fakeSdk = {
    Client: class {
      async connect() {
        connects += 1
        if (connects === 1) {
          const err = new Error("needs auth")
          err.name = "UnauthorizedError"
          throw err
        }
        return undefined
      }
      async close() {
        return undefined
      }
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      finishAuthCalled: boolean
      finishAuth: (code: string) => Promise<void>
      constructor() {
        super()
        this.finishAuthCalled = false
        this.finishAuth = async () => {
          this.finishAuthCalled = true
        }
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  let opened = false
  const callback = {
    redirectUrl: "http://127.0.0.1:1/callback",
    waitForCode: async () => ({ code: "authcode", state: undefined }),
    close: () => undefined,
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x/mcp" } },
      entry: {},
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => callback,
      openBrowser: () => {
        opened = true
      },
      onAuthUrl: () => undefined,
    }
  )
  assert.equal(out.result.status, "authorized")
  assert.equal(opened, false) // The fake never invokes redirectToAuthorization.
  assert.equal(connects, 2) // initial (throws) + post-finishAuth reconnect
})

test("runFlow reports a CSRF state mismatch", async () => {
  const fakeSdk = {
    Client: class {
      async connect() {
        const err = new Error("unauthorized")
        err.name = "UnauthorizedError"
        throw err
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      finishAuth: (code: string) => Promise<void>
      constructor() {
        super()
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x" } },
      entry: {},
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => ({
        redirectUrl: "http://127.0.0.1:1/callback",
        waitForCode: async () => ({ code: "c", state: "WRONG" }),
        close: () => undefined,
      }),
      openBrowser: () => undefined,
      onAuthUrl: () => undefined,
      randomState: () => "EXPECTED",
    }
  )
  assert.equal(out.result.ok, false)
  assert.match(out.result.message, /CSRF/)
})
