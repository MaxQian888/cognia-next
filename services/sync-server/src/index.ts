/**
 * The sync Worker's entry point (ADR-0215 phase 2, protocol §5.6).
 *
 *   GET /v1/health          unauthenticated
 *   every other /v1/ route  bearer access token → the person's space → `SyncSpace`
 *
 * The Worker authenticates the person and names the space; the space checks
 * device proofs and every protocol rule. Responses carry `cognia-server-time`.
 */

import {
  DEVICE_PROOF_HEADER,
  MAX_PUSH_BYTES,
  PROTOCOL_VERSION,
  spaceIdFor,
} from "@cognia/sync-protocol"

import { bearerToken, verifyAccessToken } from "./access-token"
import { ConfigError, readConfig, type SyncConfig } from "./config"
import { preflightResponse, withCors } from "./cors"
import type { Env } from "./env"
import { SyncHttpError, errorReply, reply, toResponse, type SpaceReply } from "./http"
import { createJwksCache, jwksFetcher, type JwksCache } from "./jwks"
import { SOCKET_PATH, matchRoute, type RouteName } from "./routes"

export { SyncSpace } from "./space"
export { SyncAdmin } from "./admin"

/** Request bodies are small JSON: two registry entries plus ≤ 33 envelopes fit well within this. */
export const MAX_BODY_BYTES = 64 * 1024

/** An op push may carry up to 1 MiB (protocol §7.3); everything else is small. */
function bodyLimit(route: RouteName): number {
  return route === "ops.push" ? MAX_PUSH_BYTES : MAX_BODY_BYTES
}

/** A space id: unpadded base64url SHA-256. */
const SPACE_ID = /^[A-Za-z0-9_-]{43}$/

let jwks: { issuer: string; cache: JwksCache } | null = null

function jwksFor(config: SyncConfig, env: Env): JwksCache {
  if (jwks?.issuer !== config.issuer) {
    jwks = {
      issuer: config.issuer,
      cache: createJwksCache(jwksFetcher(config.issuer, env.IDENTITY)),
    }
  }
  return jwks.cache
}

/** Test seam: forget the cached JWKS. */
export function resetJwksCache(): void {
  jwks = null
}

async function readBody(request: Request, limit: number): Promise<string | null> {
  if (request.method === "GET" || request.method === "HEAD") return null
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > limit) throw new SyncHttpError(413, "payload_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > limit) throw new SyncHttpError(413, "payload_too_large")
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new SyncHttpError(400, "bad_request", "the body is not UTF-8")
  }
}

async function route(
  request: Request,
  env: Env,
  config: SyncConfig,
  now: number
): Promise<SpaceReply> {
  const url = new URL(request.url)
  const matched = matchRoute(request.method, url.pathname)
  if (!matched) throw new SyncHttpError(404, "not_found")
  if (matched.name === "health") return reply({ ok: true, protocolVersion: PROTOCOL_VERSION })

  const token = bearerToken(request)
  if (!token) throw new SyncHttpError(401, "unauthorized", "a bearer access token is required")
  const userId = await verifyAccessToken(token, {
    jwks: jwksFor(config, env),
    issuer: config.issuer,
    audience: config.audience,
  })
  const spaceId = await spaceIdFor(config.issuer, userId)
  const body = await readBody(request, bodyLimit(matched.name))
  const stub = env.SYNC_SPACE.get(env.SYNC_SPACE.idFromName(spaceId))
  return stub.handle({
    route: matched.name,
    requestId: matched.requestId,
    method: request.method.toUpperCase(),
    path: url.pathname + url.search,
    after: url.searchParams.get("after"),
    wait: url.searchParams.get("wait"),
    body,
    proof: request.headers.get(DEVICE_PROOF_HEADER),
    spaceId,
    now,
  })
}

export async function handleRequest(
  request: Request,
  env: Env,
  now: number = Date.now()
): Promise<Response> {
  let config: SyncConfig
  try {
    config = readConfig(env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.error(`[sync] configuration error: ${error.message}`)
    return toResponse(errorReply(new SyncHttpError(503, "server_misconfigured")), now)
  }
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname === SOCKET_PATH && request.method === "GET") {
    // No bearer token on a WebSocket: the named space checks the single-use ticket.
    const spaceId = url.searchParams.get("space") ?? ""
    if (!SPACE_ID.test(spaceId) || !url.searchParams.get("ticket"))
      return toResponse(
        errorReply(new SyncHttpError(401, "bad_ticket", "no such socket ticket")),
        now
      )
    return env.SYNC_SPACE.get(env.SYNC_SPACE.idFromName(spaceId)).fetch(request)
  }
  if (request.method === "OPTIONS") {
    return pathname.startsWith("/v1/")
      ? preflightResponse(request, config.webOrigins)
      : toResponse(errorReply(new SyncHttpError(404, "not_found")), now)
  }
  let result: SpaceReply
  try {
    result = await route(request, env, config, now)
  } catch (error) {
    if (!(error instanceof SyncHttpError)) throw error
    result = errorReply(error)
  }
  return withCors(toResponse(result, now), request, config.webOrigins)
}

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>
