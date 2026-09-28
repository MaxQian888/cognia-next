import type { TransportOptions, OAuthTransport } from "./types.ts"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { FakeOAuthTransport } from "../../../test-support/oauth-transport.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { prepareHeadlessFlow, completeHeadlessFlow } from "../../../mcp-oauth-helper.mjs"

test("prepareHeadlessFlow returns a resumable authorization URL and PKCE entry", async () => {
  const fakeSdk = {
    Client: class {
      async connect(transport: OAuthTransport & { provider: OAuthClientProvider }) {
        await transport.provider.redirectToAuthorization(new URL("https://issuer.example/auth"))
        await transport.provider.saveCodeVerifier("pkce-verifier")
        const error = new Error("unauthorized")
        error.name = "UnauthorizedError"
        throw error
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      provider: OAuthClientProvider
      constructor(_url: URL, options?: TransportOptions) {
        super()
        this.provider = options!.authProvider!
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  const out = await prepareHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: {},
      redirectUrl: "http://localhost:3000/integrations/mcp/oauth/callback",
      state: "a".repeat(64),
    },
    { sdk: fakeSdk }
  )

  assert.equal(out.result.status, "pending")
  assert.equal(out.authorizationUrl, "https://issuer.example/auth")
  assert.equal(out.entry!.codeVerifier, "pkce-verifier")
})

test("completeHeadlessFlow exchanges the code with the persisted PKCE state", async () => {
  let finishedWith
  const fakeSdk = {
    Client: class {
      async connect() {}
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {
      finishAuth: (code: string) => Promise<void>
      constructor(_url: URL, options?: TransportOptions) {
        super()
        this.finishAuth = async (code: string) => {
          finishedWith = code
          await options!.authProvider!.saveTokens({
            access_token: "token",
            token_type: "Bearer",
            expires_in: 60,
          })
        }
      }
    },
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  const out = await completeHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: { codeVerifier: "pkce-verifier" },
      redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
      state: "b".repeat(64),
      code: "authorization-code",
    },
    { sdk: fakeSdk }
  )

  assert.equal(finishedWith, "authorization-code")
  assert.equal(out.result.status, "authorized")
  assert.equal(out.entry!.tokens!.access_token, "token")
  assert.equal(out.entry!.codeVerifier, undefined)
})

test("Headless stages reject malformed resumable inputs before loading the SDK", async () => {
  const server = { transport: "http", config: { url: "https://mcp.example/rpc" } }
  const invalidState = await prepareHeadlessFlow({
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "short",
  })
  const invalidCode = await completeHeadlessFlow({
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "c".repeat(64),
    code: "",
  })

  assert.match(invalidState.result.message, /256-bit OAuth state/)
  assert.match(invalidCode.result.message, /authorization code/)
})

test("prepareHeadlessFlow rejects unsupported transports and unsafe redirects", async () => {
  const stdio = await prepareHeadlessFlow({
    server: { transport: "stdio", config: {} },
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "d".repeat(64),
  })
  const unsafeRedirect = await prepareHeadlessFlow({
    server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
    entry: {},
    redirectUrl: "http://brain.example/integrations/mcp/oauth/callback",
    state: "e".repeat(64),
  })

  assert.equal(stdio.result.status, "unsupported")
  assert.match(unsafeRedirect.result.message, /redirect requires HTTPS/)
})

test("prepareHeadlessFlow reports non-auth failures and missing authorization URLs", async () => {
  const server = { transport: "http", config: { url: "https://mcp.example/rpc" } }
  const makeSdk = (error: Error) => ({
    Client: class {
      async connect() {
        throw error
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {},
    SSEClientTransport: class extends FakeOAuthTransport {},
  })
  const input = {
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "f".repeat(64),
  }
  const connectionFailure = await prepareHeadlessFlow(input, {
    sdk: makeSdk(new Error("network down")),
  })
  const unauthorized = new Error("authorization required")
  unauthorized.name = "UnauthorizedError"
  const missingUrl = await prepareHeadlessFlow(input, { sdk: makeSdk(unauthorized) })

  assert.match(connectionFailure.result.message, /connect failed: network down/)
  assert.match(missingUrl.result.message, /no authorization URL/)
})

test("completeHeadlessFlow rejects transports without an authorization-code exchange", async () => {
  const fakeSdk = {
    Client: class {
      async connect() {
        assert.fail("missing finishAuth must prevent connection")
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class extends FakeOAuthTransport {},
    SSEClientTransport: class extends FakeOAuthTransport {},
  }
  const out = await completeHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: { codeVerifier: "pkce-verifier" },
      redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
      state: "1".repeat(64),
      code: "authorization-code",
    },
    { sdk: fakeSdk }
  )

  assert.match(out.result.message, /transport has no finishAuth/)
})
