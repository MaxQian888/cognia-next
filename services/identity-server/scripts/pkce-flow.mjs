#!/usr/bin/env node
/**
 * SPIKE: drive the Cognia public-client PKCE flow against an OIDC issuer
 * without a browser, and print the token response.
 *
 *   node scripts/pkce-flow.mjs <issuer> <client_id> <resource>
 *
 * Signs a fresh user up with email/password (Better Auth only), then runs
 * authorize → code → token exactly as a native app would, with the loopback
 * redirect the client registered.
 */
import { createHash, randomBytes } from "node:crypto"

const [issuer, clientId, resource] = process.argv.slice(2)
if (!issuer || !clientId || !resource) {
  console.error("usage: pkce-flow.mjs <issuer> <client_id> <resource>")
  process.exit(2)
}
const redirectUri = "http://127.0.0.1:53682/callback"
const base64url = (buffer) => buffer.toString("base64url")

const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()
const origin = new URL(issuer).origin

// 1. A session at the issuer (stands in for the login page).
const email = `ada-${Date.now()}@example.com`
const signUp = await fetch(`${issuer}/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email, password: "correct-horse-battery", name: "Ada" }),
})
if (!signUp.ok) throw new Error(`sign-up failed ${signUp.status}: ${await signUp.text()}`)
const cookie = signUp.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ")

// 2. Authorize with PKCE S256.
const verifier = base64url(randomBytes(32))
const challenge = base64url(createHash("sha256").update(verifier).digest())
const state = base64url(randomBytes(16))
const authorize = new URL(discovery.authorization_endpoint)
for (const [key, value] of Object.entries({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: "openid profile offline_access sync",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource,
})) {
  authorize.searchParams.set(key, value)
}
const authorizeResponse = await fetch(authorize, { headers: { cookie }, redirect: "manual" })
// Better Auth answers a non-navigation request with {redirect, url} JSON
// instead of a 302; a real app gets the 302 in the system browser.
const location =
  authorizeResponse.headers.get("location") ??
  (authorizeResponse.headers.get("content-type")?.includes("json")
    ? (await authorizeResponse.clone().json()).url
    : null)
if (!location)
  throw new Error(
    `authorize did not redirect: ${authorizeResponse.status} ${await authorizeResponse.text()}`
  )
const callback = new URL(location, issuer)
if (callback.searchParams.get("state") !== state) throw new Error(`state mismatch: ${location}`)
const code = callback.searchParams.get("code")
if (!code) throw new Error(`no code: ${location}`)

// 3. Token exchange as a public client (no secret).
const tokenResponse = await fetch(discovery.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
})
const tokens = await tokenResponse.json()
if (!tokenResponse.ok)
  throw new Error(`token failed ${tokenResponse.status}: ${JSON.stringify(tokens)}`)

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
const header = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString())
console.log(
  JSON.stringify(
    {
      email,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      has_refresh_token: Boolean(tokens.refresh_token),
      access_token_header:
        tokens.access_token?.split(".").length === 3 ? header(tokens.access_token) : "opaque",
      access_token_claims:
        tokens.access_token?.split(".").length === 3 ? decode(tokens.access_token) : "opaque",
      id_token_claims: tokens.id_token ? decode(tokens.id_token) : null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    },
    null,
    2
  )
)
