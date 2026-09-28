import type { AuthState } from "./types.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomState, buildProvider } from "../../../mcp-oauth-helper.mjs"

test("randomState returns 16 hex chars", () => {
  const s = randomState()
  assert.match(s, /^[0-9a-f]{16}$/)
})

test("buildProvider reads/writes the seeded state and stamps expiry", () => {
  const state: AuthState = { tokens: { access_token: "seed", token_type: "Bearer" } }
  const provider = buildProvider(state, {
    redirectUrl: "http://127.0.0.1:1/callback",
    state: "csrf",
  })
  assert.equal(provider.redirectUrl, "http://127.0.0.1:1/callback")
  assert.equal(provider.state(), "csrf")
  assert.deepEqual(provider.tokens(), { access_token: "seed", token_type: "Bearer" })

  provider.saveClientInformation({ client_id: "c" })
  assert.deepEqual(state.clientInformation, { client_id: "c" })

  provider.saveCodeVerifier("v")
  assert.equal(provider.codeVerifier(), "v")

  provider.saveTokens({ access_token: "new", token_type: "Bearer", expires_in: 100 })
  assert.equal(state.tokens!.access_token, "new")
  assert.equal(state.codeVerifier, undefined) // cleared on token save
  assert.equal(typeof state.expiresAtMs, "number")
})

test("buildProvider.codeVerifier throws when none is saved", () => {
  const provider = buildProvider({}, { redirectUrl: "http://x/callback" })
  assert.throws(() => provider.codeVerifier(), /No PKCE code verifier/)
})
