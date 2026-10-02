/**
 * Anonymous reads: `GET /snapshot` and `GET /healthz`.
 *
 * A snapshot read is one primary-key row, cached at the edge for at most
 * 30 s. The stored body is returned verbatim except `serverTime`, which is
 * stamped on every response (cached or not) so the page can calibrate its
 * clock against the real current time and judge `generatedAt` honestly.
 */

import {
  HISTORY_RANGES,
  STATUS_SCHEMA_VERSION,
  type HistoryRange,
  type StatusBackendHealth,
} from "../../../../../lib/status/contract"
import { toIso } from "../../../../../lib/status/derive"
import type { Env } from "../env"
import { applyPublicCors, errorResponse, json, type RequestContext } from "../platform/http"

export const SNAPSHOT_EDGE_TTL_SECONDS = 30
const CACHED_AT_HEADER = "x-status-cached-at"
const DEFAULT_RANGE: HistoryRange = "90d"

function parseRange(value: string | null): HistoryRange | null {
  if (value === null || value === "") return DEFAULT_RANGE
  return (HISTORY_RANGES as readonly string[]).includes(value) ? (value as HistoryRange) : null
}

/** Replace the top-level `serverTime` value (first occurrence; it precedes nested objects). */
export function stampServerTime(body: string, nowMs: number): string {
  return body.replace(/"serverTime":"[^"]*"/, `"serverTime":"${toIso(nowMs)}"`)
}

export async function handleSnapshot(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  for (const key of ctx.url.searchParams.keys()) {
    if (key !== "range") return errorResponse("bad_request", ctx, { publicRead: true })
  }
  const range = parseRange(ctx.url.searchParams.get("range"))
  if (!range) return errorResponse("bad_request", ctx, { publicRead: true })

  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(`${env.PUBLIC_ORIGIN}/api/status/v1/snapshot?range=${range}`, {
    method: "GET",
  })
  // The edge copy holds the stored body unstamped plus the time it was
  // cached. A copy older than the TTL is a miss whatever the platform's own
  // expiry does, so a visitor never gets a body older than one snapshot
  // generation plus 30 s.
  let cached = await cache.match(cacheKey)
  const cachedAt = Number(cached?.headers.get(CACHED_AT_HEADER) ?? Number.NaN)
  if (cached && !(ctx.nowMs - cachedAt <= SNAPSHOT_EDGE_TTL_SECONDS * 1_000)) {
    ctx.waitUntil(cache.delete(cacheKey))
    cached = undefined
  }
  let body: string
  let etag: string
  let revision: string
  if (cached) {
    body = await cached.text()
    etag = cached.headers.get("etag") ?? ""
    revision = cached.headers.get("x-status-revision") ?? ""
  } else {
    const row = await env.DB.prepare("SELECT revision, etag, body FROM snapshots WHERE range = ?")
      .bind(range)
      .first<{ revision: number; etag: string; body: string }>()
    if (!row) return errorResponse("unavailable", ctx, { publicRead: true })
    body = row.body
    etag = row.etag
    revision = String(row.revision)
    const entry = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, s-maxage=${SNAPSHOT_EDGE_TTL_SECONDS}`,
        etag,
        "x-status-revision": revision,
        [CACHED_AT_HEADER]: String(ctx.nowMs),
      },
    })
    ctx.waitUntil(cache.put(cacheKey, entry))
  }
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    // The body carries the page's clock reference (`serverTime`), so no HTTP
    // cache may replay it: a revalidated or cached copy would make an old
    // snapshot look fresh. Our own edge cache above bounds the D1 reads.
    "cache-control": "no-store",
    etag,
    "x-status-revision": revision,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  })
  applyPublicCors(headers)
  if (request.method === "HEAD") return new Response(null, { status: 200, headers })
  // Stamped per response, never cached: this is the page's clock reference.
  return new Response(stampServerTime(body, ctx.nowMs), { status: 200, headers })
}

export async function handleHealthz(env: Env, ctx: RequestContext): Promise<Response> {
  let database: "ok" | "error" = "ok"
  let snapshotAgeMs: number | null = null
  try {
    const row = await env.DB.prepare("SELECT MAX(generated_at) AS generated FROM snapshots").first<{
      generated: number | null
    }>()
    snapshotAgeMs = row?.generated == null ? null : Math.max(0, ctx.nowMs - row.generated)
  } catch {
    database = "error"
  }
  const body: StatusBackendHealth = {
    ok: database === "ok",
    service: "cognia-status",
    version: env.SERVICE_VERSION ?? "0.0.0",
    build: env.BUILD_SHA ? env.BUILD_SHA : null,
    schemaVersion: STATUS_SCHEMA_VERSION,
    database,
    snapshotAgeMs,
  }
  return json(body, { status: body.ok ? 200 : 503, publicRead: true })
}
