import { describe, expect, it } from "vitest"

import {
  authorize,
  call,
  exchangeCode,
  NATIVE_REDIRECT,
  pkcePair,
  signedInSession,
  testEnv,
} from "../test/helpers"
import {
  APP_RETURN_CLAIM_PATH,
  handleAppReturnClaim,
  purgeExpiredAppReturns,
  recordAppAuthorize,
  recordAppReturn,
} from "./app-return"

function claim(body: unknown): Promise<Response> {
  return call(APP_RETURN_CLAIM_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** A signed-in native authorize request: the issuer redirects the code to the app. */
async function nativeSignIn() {
  const session = await signedInSession()
  const { verifier, challenge } = await pkcePair()
  const state = `state-${crypto.randomUUID()}`
  const landing = await authorize({
    cookie: session.cookie,
    challenge,
    state,
    redirectUri: NATIVE_REDIRECT,
  })
  return { verifier, state, landing }
}

async function rowCount(): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM "app_return"`).first<{
    n: number
  }>()
  return row?.n ?? 0
}

describe("app returns", () => {
  it("hands the app the code it never received, to the holder of the verifier, once", async () => {
    const { verifier, state, landing } = await nativeSignIn()
    expect(`${landing.protocol}${landing.pathname}`).toBe(NATIVE_REDIRECT)
    const issued = landing.searchParams.get("code")

    const claimed = await claim({ state, code_verifier: verifier })
    expect(claimed.status).toBe(200)
    expect(claimed.headers.get("cache-control")).toBe("no-store")
    expect(await claimed.json()).toEqual({ code: issued, state })

    // The claimed code is an ordinary code: redeemed with the same verifier.
    const tokens = await exchangeCode({ code: issued!, verifier, redirectUri: NATIVE_REDIRECT })
    expect(tokens.status).toBe(200)

    // Taken once.
    expect((await claim({ state, code_verifier: verifier })).status).toBe(404)
  })

  it("refuses a claim without the verifier, and leaves the code for the one who has it", async () => {
    const { verifier, state } = await nativeSignIn()
    const other = await pkcePair()
    const refused = await claim({ state, code_verifier: other.verifier })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: "not_found" })
    expect((await claim({ state, code_verifier: verifier })).status).toBe(200)
  })

  it("answers the same 404 for an unknown state and a request still waiting for its code", async () => {
    expect((await claim({ state: "never-seen", code_verifier: "v" })).status).toBe(404)

    // Not signed in: the request is recorded, but no code has been issued yet.
    const { verifier, challenge } = await pkcePair()
    const state = `pending-${crypto.randomUUID()}`
    const landing = await authorize({ challenge, state, redirectUri: NATIVE_REDIRECT })
    expect(landing.pathname).toBe("/sign-in")
    expect((await claim({ state, code_verifier: verifier })).status).toBe(404)
  })

  it("rejects malformed claims and other methods", async () => {
    expect((await claim({ state: "s" })).status).toBe(400)
    expect((await claim("not an object")).status).toBe(400)
    const raw = await call(APP_RETURN_CLAIM_PATH, { method: "POST", body: "{" })
    expect(raw.status).toBe(400)
    expect((await call(APP_RETURN_CLAIM_PATH)).status).toBe(405)
  })

  it("records only the native client's S256 requests", async () => {
    const before = await rowCount()
    const { challenge } = await pkcePair()
    const base = `https://id.test/api/auth/oauth2/authorize?state=s-${crypto.randomUUID()}&code_challenge=${challenge}`
    const now = Date.now()
    for (const query of [
      `&client_id=cognia-web&redirect_uri=${encodeURIComponent(NATIVE_REDIRECT)}&code_challenge_method=S256`,
      `&client_id=cognia-app&redirect_uri=${encodeURIComponent("http://127.0.0.1/callback")}&code_challenge_method=S256`,
      `&client_id=cognia-app&redirect_uri=${encodeURIComponent(NATIVE_REDIRECT)}&code_challenge_method=plain`,
    ]) {
      await recordAppAuthorize(testEnv.DB, new Request(base + query), now)
    }
    await recordAppAuthorize(
      testEnv.DB,
      new Request("https://id.test/api/auth/oauth2/token", { method: "POST" }),
      now
    )
    expect(await rowCount()).toBe(before)
  })

  it("keeps the first challenge for a state and the first code", async () => {
    const now = Date.now()
    const first = await pkcePair()
    const second = await pkcePair()
    const state = `s-${crypto.randomUUID()}`
    const request = (challenge: string) =>
      new Request(
        `https://id.test/api/auth/oauth2/authorize?client_id=cognia-app&redirect_uri=${encodeURIComponent(
          NATIVE_REDIRECT
        )}&code_challenge_method=S256&state=${state}&code_challenge=${challenge}`
      )
    await recordAppAuthorize(testEnv.DB, request(first.challenge), now)
    await recordAppAuthorize(testEnv.DB, request(second.challenge), now)
    await recordAppReturn(testEnv.DB, `${NATIVE_REDIRECT}?code=first&state=${state}`, now)
    await recordAppReturn(testEnv.DB, `${NATIVE_REDIRECT}?code=second&state=${state}`, now)

    const claimFor = (verifier: string, at: number) =>
      handleAppReturnClaim(
        new Request("https://id.test/x", {
          method: "POST",
          body: JSON.stringify({ state, code_verifier: verifier }),
        }),
        testEnv.DB,
        at
      )
    expect((await claimFor(second.verifier, now)).status).toBe(404)
    const claimed = await claimFor(first.verifier, now)
    expect(await claimed.json()).toEqual({ code: "first", state })
  })

  it("expires codes and pending requests, and the cron purges them", async () => {
    const now = Date.now()
    const { verifier, challenge } = await pkcePair()
    const state = `s-${crypto.randomUUID()}`
    await recordAppAuthorize(
      testEnv.DB,
      new Request(
        `https://id.test/api/auth/oauth2/authorize?client_id=cognia-app&redirect_uri=${encodeURIComponent(
          NATIVE_REDIRECT
        )}&code_challenge_method=S256&state=${state}&code_challenge=${challenge}`
      ),
      now
    )
    await recordAppReturn(testEnv.DB, `${NATIVE_REDIRECT}?code=c&state=${state}`, now)
    const late = now + 3 * 60_000 + 1
    const claimed = await handleAppReturnClaim(
      new Request("https://id.test/x", {
        method: "POST",
        body: JSON.stringify({ state, code_verifier: verifier }),
      }),
      testEnv.DB,
      late
    )
    expect(claimed.status).toBe(404)
    const before = await rowCount()
    await purgeExpiredAppReturns(testEnv.DB, late)
    expect(await rowCount()).toBeLessThan(before)
  })
})
