// Cloudflare Worker for the cognia public share service (zero-knowledge).
//
// The Worker is a blind store: it holds opaque AES-GCM envelopes in R2 and
// per-share lifecycle counters in KV. It never sees the decryption key (that
// rides in the URL #fragment, which browsers never send to the server) and the
// payload's kind/mime live inside the ciphertext. Writes and deletes require a
// bearer secret the owner configures; reads are public but lifecycle-gated
// (TTL, max-views, burn-after-read, revoke).
//
// This deliberately mirrors the signaling worker's posture: free-tier friendly
// (R2 + KV), one custom domain, observability on. It is a separate Node project
// (own package.json + lockfile), not part of the app's pnpm workspace.

export interface Env {
  /** Opaque envelope bodies, keyed `share/<code>`. */
  SHARE_BUCKET: R2Bucket
  /** Lifecycle metadata, keyed `meta:<code>`. */
  SHARE_KV: KVNamespace
  /** Bearer secret required for POST / DELETE / stats. */
  SHARE_UPLOAD_SECRET: string
  /** Max envelope body size in bytes (string env var). Default 10 MiB. */
  MAX_BODY_BYTES?: string
  /** Hard ceiling on share TTL in seconds (string env var). Default 30 days. */
  MAX_TTL_SECONDS?: string
}

interface ShareMeta {
  createdAt: number
  expiresAt?: number
  maxViews?: number
  burnAfterRead: boolean
  viewCount: number
  revoked: boolean
  /**
   * Per-share owner secret minted at create time and returned only to the
   * creator. Required (constant-time matched) for stats/delete so that — on a
   * shared multi-tenant deployment — possessing the global upload secret does
   * NOT let one tenant inspect or destroy another tenant's shares. Absent on
   * legacy rows created before this field existed (those fall back to the
   * upload-secret gate).
   */
  ownerToken?: string
}

// Exported for the constants-parity test against ../../share-constants.json
// (kept in lockstep with the Rust axum server — see that file's _comment).
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
export const KV_MIN_TTL_SECONDS = 60
/** Hard ceiling on share lifetime so every object eventually self-expires from
 * KV even when the creator omits a TTL — bounds storage growth on a shared
 * deployment. 30 days. Overridable via the `MAX_TTL_SECONDS` env var. */
export const DEFAULT_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
export const CODE_LENGTH = 12
export const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const OWNER_TOKEN_BYTES = 32

const CORS_HEADERS: Record<string, string> = {
  // The bearer secret — not cookies — is the gate, so a wildcard origin is safe.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Owner-Token",
  "Access-Control-Max-Age": "86400",
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  })
}

/** Length-independent constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Compare against a fixed-length digest so length never short-circuits.
  let mismatch = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return mismatch === 0
}

function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? ""
  const prefix = "Bearer "
  if (!header.startsWith(prefix) || !env.SHARE_UPLOAD_SECRET) return false
  return timingSafeEqual(header.slice(prefix.length), env.SHARE_UPLOAD_SECRET)
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  let out = ""
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/** Mint a random per-share owner secret as lowercase hex. */
function generateOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(OWNER_TOKEN_BYTES))
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/**
 * Authorize an owner-only action (stats / delete) for a specific share.
 *
 * New shares carry a per-share `ownerToken`; the caller proves ownership by
 * presenting it in the `X-Owner-Token` header (constant-time matched). Legacy
 * shares (no `ownerToken`) fall back to the global upload-secret gate so they
 * remain manageable. The global upload secret alone never authorizes actions on
 * a share that has its own owner token — this is what isolates tenants.
 */
function isShareOwner(request: Request, meta: ShareMeta, env: Env): boolean {
  if (meta.ownerToken) {
    const supplied = request.headers.get("X-Owner-Token") ?? ""
    return timingSafeEqual(supplied, meta.ownerToken)
  }
  return isAuthorized(request, env)
}

function maxTtlSeconds(env: Env): number {
  const parsed = Number(env.MAX_TTL_SECONDS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TTL_SECONDS
}

function looksLikeEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return (
    e.v === 1 &&
    e.alg === "AES-GCM" &&
    typeof e.iv === "string" &&
    typeof e.ciphertext === "string" &&
    typeof e.checksum === "string"
  )
}

function maxBodyBytes(env: Env): number {
  const parsed = Number(env.MAX_BODY_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES
}

async function deleteShare(env: Env, code: string): Promise<void> {
  await Promise.all([env.SHARE_BUCKET.delete(`share/${code}`), env.SHARE_KV.delete(`meta:${code}`)])
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401)

  const declared = Number(request.headers.get("Content-Length") ?? "")
  if (Number.isFinite(declared) && declared > maxBodyBytes(env)) {
    return json({ error: "payload too large" }, 413)
  }

  const raw = await request.text()
  if (raw.length > maxBodyBytes(env)) return json({ error: "payload too large" }, 413)

  let body: { envelope?: unknown; ttlSeconds?: number; maxViews?: number; burnAfterRead?: boolean }
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  if (!looksLikeEnvelope(body.envelope)) return json({ error: "invalid envelope" }, 400)

  const now = Date.now()
  const maxTtl = maxTtlSeconds(env)
  // Clamp the requested TTL to the hard ceiling, and always apply a TTL (the
  // ceiling, when none is requested) so every share eventually self-expires —
  // an unbounded never-expiring share is a storage-exhaustion vector on a
  // shared deployment.
  const requestedTtl =
    typeof body.ttlSeconds === "number" && body.ttlSeconds > 0 ? body.ttlSeconds : undefined
  const ttl = Math.min(requestedTtl ?? maxTtl, maxTtl)
  const expiresAt = now + ttl * 1000
  const burnAfterRead = Boolean(body.burnAfterRead)
  const maxViews = burnAfterRead
    ? 1
    : typeof body.maxViews === "number" && body.maxViews > 0
      ? Math.floor(body.maxViews)
      : undefined

  const code = generateCode()
  const ownerToken = generateOwnerToken()
  const meta: ShareMeta = {
    createdAt: now,
    expiresAt,
    maxViews,
    burnAfterRead,
    viewCount: 0,
    revoked: false,
    ownerToken,
  }

  await env.SHARE_BUCKET.put(`share/${code}`, JSON.stringify(body.envelope), {
    httpMetadata: { contentType: "application/json" },
  })
  await env.SHARE_KV.put(`meta:${code}`, JSON.stringify(meta), {
    expirationTtl: Math.max(ttl, KV_MIN_TTL_SECONDS),
  })

  return json({ code, ownerToken, expiresAt }, 201)
}

async function readMeta(env: Env, code: string): Promise<ShareMeta | null> {
  const raw = await env.SHARE_KV.get(`meta:${code}`)
  return raw ? (JSON.parse(raw) as ShareMeta) : null
}

async function handleRead(env: Env, code: string, ctx: ExecutionContext): Promise<Response> {
  const meta = await readMeta(env, code)
  if (!meta || meta.revoked) {
    // KV gone (expired) but R2 may linger — lazily reap the orphan.
    ctx.waitUntil(env.SHARE_BUCKET.delete(`share/${code}`).catch(() => {}))
    return json({ error: "not found" }, 404)
  }
  if (meta.expiresAt && Date.now() >= meta.expiresAt) {
    ctx.waitUntil(deleteShare(env, code))
    return json({ error: "not found" }, 404)
  }
  if (typeof meta.maxViews === "number" && meta.viewCount >= meta.maxViews) {
    ctx.waitUntil(deleteShare(env, code))
    return json({ error: "not found" }, 404)
  }

  const object = await env.SHARE_BUCKET.get(`share/${code}`)
  if (!object) {
    ctx.waitUntil(env.SHARE_KV.delete(`meta:${code}`))
    return json({ error: "not found" }, 404)
  }
  const envelopeText = await object.text()

  const nextCount = meta.viewCount + 1
  const exhausted = typeof meta.maxViews === "number" && nextCount >= meta.maxViews
  if (exhausted) {
    // This is the last allowed view — hand back the body, then destroy.
    ctx.waitUntil(deleteShare(env, code))
  } else {
    const updated: ShareMeta = { ...meta, viewCount: nextCount }
    const remainingTtl = meta.expiresAt
      ? Math.ceil((meta.expiresAt - Date.now()) / 1000)
      : undefined
    ctx.waitUntil(
      env.SHARE_KV.put(`meta:${code}`, JSON.stringify(updated), {
        ...(remainingTtl && remainingTtl > 0
          ? { expirationTtl: Math.max(remainingTtl, KV_MIN_TTL_SECONDS) }
          : {}),
      })
    )
  }

  return new Response(`{"envelope":${envelopeText}}`, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  })
}

async function handleStats(request: Request, env: Env, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  // Ownership is checked against the share's own token, so a missing share is
  // a 404 regardless of credentials (no oracle for which codes exist).
  if (!meta) return json({ error: "not found" }, 404)
  if (meta.expiresAt && Date.now() >= meta.expiresAt) {
    await deleteShare(env, code)
    return json({ error: "not found" }, 404)
  }
  if (!isShareOwner(request, meta, env)) return json({ error: "unauthorized" }, 401)
  return json({
    viewCount: meta.viewCount,
    expiresAt: meta.expiresAt,
    revoked: meta.revoked,
    maxViews: meta.maxViews,
  })
}

async function handleDelete(request: Request, env: Env, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  // Already gone (expired / burned / never existed) → idempotent success
  // without leaking existence or requiring a credential.
  if (!meta) return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (meta.expiresAt && Date.now() >= meta.expiresAt) {
    await deleteShare(env, code)
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (!isShareOwner(request, meta, env)) return json({ error: "unauthorized" }, 401)
  await deleteShare(env, code)
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const { pathname } = url

    // API surface.
    if (pathname === "/v1/share" && request.method === "POST") {
      return handleCreate(request, env)
    }
    const match = pathname.match(/^\/v1\/share\/([^/]+)(\/stats)?$/)
    if (match) {
      const code = decodeURIComponent(match[1])
      const isStats = Boolean(match[2])
      if (isStats) {
        if (request.method === "GET") return handleStats(request, env, code)
      } else if (request.method === "GET") {
        return handleRead(env, code, ctx)
      } else if (request.method === "DELETE") {
        return handleDelete(request, env, code)
      }
      return json({ error: "method not allowed" }, 405)
    }

    // Everything else is not ours. The viewer is now the app's own
    // `/share/view` route served by Cloudflare Pages (ADR-0037 Phase 4); this
    // Worker is a pure JSON API scoped to `/v1/*`.
    return json({ error: "not found" }, 404)
  },
} satisfies ExportedHandler<Env>
