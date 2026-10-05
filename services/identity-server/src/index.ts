/**
 * The identity Worker's entry point (ADR-0215 §2).
 *
 *   /sign-in, /consent, /error, /signed-out   hosted pages
 *   /api/auth/*                               Better Auth, behind the route allowlist
 *   /api/account/deletion                     account deletion (src/deletion/)
 *   cron                                      purge accounts past their cooling-off period
 *
 * One Better Auth instance per isolate: constructing it seeds the sync
 * resource into D1, which must not happen on every request.
 */

import { waitUntil } from "cloudflare:workers"
import type { JSONWebKeySet } from "jose"

import { createAuth, type Auth } from "./auth"
import { ConfigError, readConfig, type IdentityConfig } from "./config"
import { ACCOUNT_DELETION_PATH, isCorsPath, preflightResponse, withCors } from "./cors"
import { handleDeletionRequest } from "./deletion/routes"
import { purgeDueDeletions, purgeHooksFor } from "./deletion/purge"
import type { Env } from "./env"
import { reconcileWebClient } from "./first-party-clients"
import { consentPage } from "./pages/consent"
import { signInPage } from "./pages/sign-in"
import { errorPage, signedOutPage } from "./pages/status-pages"
import { mintAppleClientSecret } from "./providers/apple-secret"
import { normalizeRevocation, REVOKE_PATH } from "./revocation"
import { isBrowserNavigation, isNativeAppRedirect, returnToAppPage } from "./pages/return-to-app"
import { isAllowedAuthRoute } from "./route-allowlist"
import { serveOwnJwks } from "./self-jwks"

interface CachedAuth {
  fingerprint: string
  auth: Auth
}

let cached: CachedAuth | null = null

async function authFor(config: IdentityConfig, env: Env): Promise<Auth> {
  const appleClientSecret = config.providers.apple
    ? await mintAppleClientSecret(config.providers.apple)
    : undefined
  // A rotated Apple secret or a changed configuration builds a new instance.
  const fingerprint = JSON.stringify([config, appleClientSecret ?? null])
  if (cached?.fingerprint === fingerprint) return cached.auth
  const auth = createAuth(config, env.DB, {
    ...(appleClientSecret ? { appleClientSecret } : {}),
    waitUntil,
  })
  cached = { fingerprint, auth }
  // RP-initiated logout downloads this issuer's own JWKS; answer it in-process.
  serveOwnJwks(`${config.issuer}/jwks`, () => auth.api.getJwks())
  return auth
}

async function jwksOf(auth: Auth): Promise<JSONWebKeySet> {
  return (await auth.api.getJwks()) as unknown as JSONWebKeySet
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 })
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  let config: IdentityConfig
  try {
    config = readConfig(env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.error(`[identity] configuration error: ${error.message}`)
    return Response.json({ error: "server_misconfigured" }, { status: 503 })
  }
  const { pathname } = new URL(request.url)
  const method = request.method.toUpperCase()

  if (method === "OPTIONS") {
    return isCorsPath(pathname) ? preflightResponse(request, config.webOrigins) : notFound()
  }

  if (method === "GET" || method === "HEAD") {
    if (pathname === "/sign-in") return signInPage(request, config)
    if (pathname === "/consent") return consentPage(request, env.DB)
    if (pathname === "/error") return errorPage(request)
    if (pathname === "/signed-out") return signedOutPage(request)
  }

  if (pathname === ACCOUNT_DELETION_PATH) {
    const auth = await authFor(config, env)
    const response = await handleDeletionRequest(request, {
      db: env.DB,
      issuer: config.issuer,
      audience: config.syncAudience,
      coolingOffDays: config.coolingOffDays,
      jwks: () => jwksOf(auth),
    })
    return withCors(response, request, config.webOrigins)
  }

  if (!isAllowedAuthRoute(method, pathname)) return notFound()
  await reconcileWebClient(env.DB, config.webOrigins)
  const auth = await authFor(config, env)
  const handled = await auth.handler(request)
  const location = handled.headers.get("location")
  // A browser navigation bound for the native app gets a page to land on
  // (pages/return-to-app.ts). API callers still see the plain redirect.
  if (
    handled.status >= 300 &&
    handled.status < 400 &&
    isBrowserNavigation(request) &&
    isNativeAppRedirect(location)
  ) {
    return returnToAppPage(request, location)
  }
  const response = pathname === REVOKE_PATH ? await normalizeRevocation(handled) : handled
  return isCorsPath(pathname) ? withCors(response, request, config.webOrigins) : response
}

export async function runScheduled(env: Env, now: Date = new Date()) {
  const config = readConfig(env)
  const auth = await authFor(config, env)
  const context = await auth.$context
  const report = await purgeDueDeletions({
    db: env.DB,
    deleteUser: (userId) => context.internalAdapter.deleteUser(userId),
    hooks: purgeHooksFor(env),
    now: () => now,
  })
  if (report.purged.length || report.failed.length) {
    console.log(
      `[identity] purged ${report.purged.length} account(s); ${report.failed.length} failed`,
      report.failed
    )
  }
  return report
}

export default {
  fetch: (request, env) => handleRequest(request, env),
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env))
  },
} satisfies ExportedHandler<Env>

/** Test seam: drop the cached Better Auth instance. */
export function resetAuthCache(): void {
  cached = null
}
