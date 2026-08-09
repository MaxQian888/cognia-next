import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parseCallback,
  randomState,
  buildProvider,
  createEgressGuard,
  validateRemoteUrl,
  runFlow,
} from "./mcp-oauth-helper.mjs"

test("parseCallback extracts code/state/error", () => {
  assert.deepEqual(parseCallback("/callback?code=abc&state=xy"), {
    code: "abc",
    state: "xy",
    error: undefined,
    errorDescription: undefined,
  })
  const denied = parseCallback("/callback?error=access_denied&error_description=nope")
  assert.equal(denied.error, "access_denied")
  assert.equal(denied.errorDescription, "nope")
})

test("parseCallback yields no code for a query-less url", () => {
  assert.equal(parseCallback("::::").code, undefined)
})

test("randomState returns 16 hex chars", () => {
  const s = randomState()
  assert.match(s, /^[0-9a-f]{16}$/)
})

test("buildProvider reads/writes the seeded state and stamps expiry", () => {
  const state = { tokens: { access_token: "seed" } }
  const provider = buildProvider(state, {
    redirectUrl: "http://127.0.0.1:1/callback",
    state: "csrf",
  })
  assert.equal(provider.redirectUrl, "http://127.0.0.1:1/callback")
  assert.equal(provider.state(), "csrf")
  assert.deepEqual(provider.tokens(), { access_token: "seed" })

  provider.saveClientInformation({ client_id: "c" })
  assert.deepEqual(state.clientInformation, { client_id: "c" })

  provider.saveCodeVerifier("v")
  assert.equal(provider.codeVerifier(), "v")

  provider.saveTokens({ access_token: "new", expires_in: 100 })
  assert.equal(state.tokens.access_token, "new")
  assert.equal(state.codeVerifier, undefined) // cleared on token save
  assert.equal(typeof state.expiresAtMs, "number")
})

test("buildProvider.codeVerifier throws when none is saved", () => {
  const provider = buildProvider({}, { redirectUrl: "http://x/callback" })
  assert.throws(() => provider.codeVerifier(), /No PKCE code verifier/)
})

test("runFlow rejects stdio servers as unsupported", async () => {
  const out = await runFlow({ server: { transport: "stdio", config: {} }, mode: "authenticate" })
  assert.equal(out.result.ok, false)
  assert.equal(out.result.status, "unsupported")
})

test("OAuth egress rejects insecure and private endpoints unless explicitly reviewed", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/mcp"), /HTTPS/)
  assert.throws(() => validateRemoteUrl("https://127.0.0.1/mcp"), /private or reserved/)
  assert.equal(validateRemoteUrl("http://127.0.0.1/mcp", true).href, "http://127.0.0.1/mcp")
  assert.throws(() => validateRemoteUrl("http://example.com/mcp", true), /HTTPS/)
})

test("guarded OAuth fetch denies redirects and carries a socket-level DNS guard", async () => {
  let agentOptions
  const dispatcher = { close: async () => undefined }
  class FakeAgent {
    constructor(options) {
      agentOptions = options
      return dispatcher
    }
  }
  let receivedInit
  const guard = createEgressGuard({
    AgentCtor: FakeAgent,
    lookup: (_hostname, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]),
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return { ok: true }
    },
  })
  await guard.fetch("https://example.com/token", { redirect: "follow" })
  assert.equal(receivedInit.redirect, "error")
  assert.equal(receivedInit.dispatcher, dispatcher)
  assert.equal(typeof agentOptions.connect.lookup, "function")
  const lookupError = await new Promise((resolve) => {
    agentOptions.connect.lookup("rebinding.example", {}, (error) => resolve(error))
  })
  assert.match(lookupError.message, /private or reserved/)
  await guard.close()
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
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class {},
  }
  const callback = {
    redirectUrl: "http://127.0.0.1:1/callback",
    waitForCode: async () => ({ code: "x" }),
    close: () => undefined,
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x/mcp" } },
      entry: { tokens: { access_token: "t" } },
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
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuthCalled = false
        this.finishAuth = async () => {
          this.finishAuthCalled = true
        }
      }
    },
    SSEClientTransport: class {},
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
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class {},
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
