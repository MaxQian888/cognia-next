/**
 * App returns: finishing a phone sign-in that ran in another app.
 *
 * On a phone the official account's Feishu sign-in runs in the Feishu app's
 * WebView (the app hands its whole authorize request to Feishu through an
 * Applink, lib/oauth/app-handoff.ts), and our return page hands the code back
 * with `cn.cognia.app:/auth/callback`. Whether that jump happens is Feishu's
 * call: it usually asks "leave Feishu?", but it can also silently refuse, and
 * the person then switches back to Cognia by hand with a code the app never
 * received, so the sign-in they just approved is lost.
 *
 * So the native client's authorize requests leave a short-lived row here:
 *
 *  1. the request arrives: record `sha256(state) → code_challenge`;
 *  2. the issuer redirects the code to the app: attach it to that row;
 *  3. the app, back in the foreground, claims the code with the PKCE
 *     verifier only it holds; a proven claim takes the code once.
 *
 * A claim proves possession of the verifier, so knowing `state` (it travels in
 * URLs, including Feishu's Applink) is not enough to take or burn the code. The
 * code is then redeemed at the token endpoint as usual, PKCE checked again.
 */

import { COGNIA_APP_CLIENT_ID, NATIVE_CALLBACK_URI } from "./first-party-clients"

export const APP_RETURN_CLAIM_PATH = "/api/app-return/claim"
const AUTHORIZE_PATH = "/api/auth/oauth2/authorize"

/** How long an authorize request may take to finish: signing in at the provider included. */
const PENDING_TTL_MS = 15 * 60_000
/** How long an issued code waits to be claimed. Matches the code's own short life. */
const CODE_TTL_MS = 3 * 60_000

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * Step 1: remember the PKCE challenge of the native client's authorize request.
 * Anything else (another client, another redirect, no S256 challenge) is not
 * an app return and leaves no row.
 */
export async function recordAppAuthorize(db: D1Database, request: Request, now: number) {
  if (request.method.toUpperCase() !== "GET") return
  const url = new URL(request.url)
  if (url.pathname !== AUTHORIZE_PATH) return
  const query = url.searchParams
  const state = query.get("state")
  const challenge = query.get("code_challenge")
  if (
    query.get("client_id") !== COGNIA_APP_CLIENT_ID ||
    query.get("redirect_uri") !== NATIVE_CALLBACK_URI ||
    query.get("code_challenge_method") !== "S256" ||
    !state ||
    !challenge
  ) {
    return
  }
  // A repeated request for the same state (a reload, the resumed authorize
  // after sign-in) keeps the first challenge: it cannot swap the binding.
  await db
    .prepare(
      `INSERT INTO "app_return" ("state_hash", "code_challenge", "code", "expires_at")
       VALUES (?1, ?2, NULL, ?3) ON CONFLICT ("state_hash") DO NOTHING`
    )
    .bind(await sha256Base64Url(state), challenge, now + PENDING_TTL_MS)
    .run()
}

/** Step 2: attach the code the issuer is redirecting to the app. First code wins. */
export async function recordAppReturn(db: D1Database, location: string, now: number) {
  const target = new URL(location)
  const code = target.searchParams.get("code")
  const state = target.searchParams.get("state")
  if (!code || !state) return
  await db
    .prepare(
      `UPDATE "app_return" SET "code" = ?1, "expires_at" = ?2
       WHERE "state_hash" = ?3 AND "code" IS NULL AND "expires_at" > ?4`
    )
    .bind(code, now + CODE_TTL_MS, await sha256Base64Url(state), now)
    .run()
}

/**
 * Step 3: `POST /api/app-return/claim` with `{ state, code_verifier }`.
 * Answers `{ code, state }` once to the holder of the verifier, and the same
 * 404 to everything else, so a probe learns nothing about which part failed.
 */
export async function handleAppReturnClaim(
  request: Request,
  db: D1Database,
  now: number
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 })
  }
  const notFound = Response.json({ error: "not_found" }, { status: 404 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }
  const state = (body as { state?: unknown })?.state
  const verifier = (body as { code_verifier?: unknown })?.code_verifier
  if (typeof state !== "string" || !state || typeof verifier !== "string" || !verifier) {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }
  const stateHash = await sha256Base64Url(state)
  const row = await db
    .prepare(
      `SELECT "code_challenge", "code" FROM "app_return"
       WHERE "state_hash" = ?1 AND "expires_at" > ?2`
    )
    .bind(stateHash, now)
    .first<{ code_challenge: string; code: string | null }>()
  if (!row?.code || (await sha256Base64Url(verifier)) !== row.code_challenge) return notFound
  // Take it once: only the delete that removed the row may answer with the code.
  const taken = await db
    .prepare(`DELETE FROM "app_return" WHERE "state_hash" = ?1 AND "code" = ?2`)
    .bind(stateHash, row.code)
    .run()
  if (!taken.meta.changes) return notFound
  return Response.json(
    { code: row.code, state },
    { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
  )
}

/** Drop rows past their life; run by the Worker's cron. */
export async function purgeExpiredAppReturns(db: D1Database, now: number) {
  await db.prepare(`DELETE FROM "app_return" WHERE "expires_at" <= ?1`).bind(now).run()
}
