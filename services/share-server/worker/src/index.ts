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
  /**
   * Hex-encoded HMAC key shared with the collaboration server, so this Worker
   * can verify the grants it mints — ADR-0149 §8.
   *
   * Unset means this deployment has no collaboration plane, never "authorize
   * anyone": every grant path refuses outright rather than falling through to
   * `SHARE_UPLOAD_SECRET`.
   */
  SHARE_GRANT_KEY?: string
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
  /**
   * The Org this share belongs to — ADR-0149 §8.
   *
   * Absent for every share created before tenancy, and for one created with
   * the global upload secret, which proves nothing about who is asking. Those
   * stay readable by code and revocable by their owner token; they are simply
   * invisible to org-scoped listing, because nothing knows whose they are and
   * guessing would be worse.
   */
  orgId?: string
  /** The person who created it. Present exactly when {@link orgId} is. */
  creatorUserId?: string
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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

/** The org and person behind a verified grant. */
interface GrantCaller {
  orgId: string
  userId: string
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? ""
  const prefix = "Bearer "
  return header.startsWith(prefix) ? header.slice(prefix.length) : null
}

function base64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0) return null
  const out = new Uint8Array(value.length / 2)
  for (let index = 0; index < out.length; index++) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[index] = byte
  }
  return out
}

/**
 * Verify the bearer as a collaboration-plane grant — ADR-0149 §8.
 *
 * The wire format is `base64url(claimsJson).base64url(hmacSha256(payload))`,
 * the same one `crates/cognia-tenant-auth` mints and `core/src/grant.rs`
 * verifies. A frozen vector at `crates/cognia-tenant-auth/fixtures/` pins all
 * three against each other, because a silent divergence would look like
 * "sharing stopped working" and nothing else.
 *
 * `null` covers every negative case on purpose — no header, no key, a bad
 * signature, an expired grant. The caller's next move is the same 401 for all
 * of them, and separating them here would only invite a handler to leak which.
 */
async function grantCaller(request: Request, env: Env): Promise<GrantCaller | null> {
  const key = env.SHARE_GRANT_KEY ? hexToBytes(env.SHARE_GRANT_KEY.trim()) : null
  if (!key || key.length < 32) return null
  const token = bearer(request)
  if (!token) return null
  const dot = token.indexOf(".")
  if (dot <= 0) return null

  const payload = token.slice(0, dot)
  const signature = base64UrlToBytes(token.slice(dot + 1))
  if (!signature) return null

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
  // `crypto.subtle.verify` is the constant-time comparison; never re-implement
  // it against a hex string here.
  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    signature,
    new TextEncoder().encode(payload)
  )
  if (!valid) return null

  const claimsBytes = base64UrlToBytes(payload)
  if (!claimsBytes) return null
  let claims: { orgId?: unknown; userId?: unknown; expiresAt?: unknown }
  try {
    claims = JSON.parse(new TextDecoder().decode(claimsBytes))
  } catch {
    return null
  }
  if (typeof claims.orgId !== "string" || typeof claims.userId !== "string") return null
  // Signature first, expiry second: an attacker must not learn whether a
  // forged payload would have been in date.
  if (typeof claims.expiresAt !== "number" || claims.expiresAt < Math.floor(Date.now() / 1000)) {
    return null
  }
  return { orgId: claims.orgId, userId: claims.userId }
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
async function isShareOwner(request: Request, meta: ShareMeta, env: Env): Promise<boolean> {
  // ADR-0149 §8 — an org grant reaches its own org's shares. This is the
  // off-boarding case: revoking what a departing person shared cannot depend
  // on still holding the per-share tokens they were handed.
  if (meta.orgId) {
    const caller = await grantCaller(request, env)
    if (caller?.orgId === meta.orgId) return true
  }
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

/**
 * Secondary index for org listing: `org:<orgId>:<code>` → "".
 *
 * KV has no query, only a prefix scan, so "which shares belong to this org"
 * needs its own key space. Written and deleted alongside the metadata; a
 * dangling index entry is filtered on read rather than trusted, because KV is
 * eventually consistent and an index that could resurrect a deleted share
 * would be worse than one that occasionally lists nothing.
 */
function orgIndexKey(orgId: string, code: string): string {
  return `org:${orgId}:${code}`
}

async function deleteShare(env: Env, code: string, orgId?: string): Promise<void> {
  await Promise.all([
    env.SHARE_BUCKET.delete(`share/${code}`),
    env.SHARE_KV.delete(`meta:${code}`),
    orgId ? env.SHARE_KV.delete(orgIndexKey(orgId, code)) : Promise.resolve(),
  ])
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  // A grant first, the legacy secret second. Order matters: the grant is the
  // credential that says WHO is asking, and a deployment that has both should
  // attribute the share rather than fall back to the anonymous path.
  const caller = await grantCaller(request, env)
  if (!caller && !isAuthorized(request, env)) return json({ error: "unauthorized" }, 401)

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
    // Both, or neither. They come from one verified grant, and half of them
    // would be a claim nobody made.
    ...(caller ? { orgId: caller.orgId, creatorUserId: caller.userId } : {}),
  }

  await env.SHARE_BUCKET.put(`share/${code}`, JSON.stringify(body.envelope), {
    httpMetadata: { contentType: "application/json" },
  })
  const kvTtl = Math.max(ttl, KV_MIN_TTL_SECONDS)
  await env.SHARE_KV.put(`meta:${code}`, JSON.stringify(meta), { expirationTtl: kvTtl })
  if (caller) {
    // Same TTL as the metadata, so the index cannot outlive what it points at.
    await env.SHARE_KV.put(orgIndexKey(caller.orgId, code), "", { expirationTtl: kvTtl })
  }

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
    ctx.waitUntil(deleteShare(env, code, meta.orgId))
    return json({ error: "not found" }, 404)
  }
  if (typeof meta.maxViews === "number" && meta.viewCount >= meta.maxViews) {
    ctx.waitUntil(deleteShare(env, code, meta.orgId))
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
    ctx.waitUntil(deleteShare(env, code, meta.orgId))
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
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  if (!(await isShareOwner(request, meta, env))) return json({ error: "unauthorized" }, 401)
  return json({
    viewCount: meta.viewCount,
    expiresAt: meta.expiresAt,
    revoked: meta.revoked,
    maxViews: meta.maxViews,
  })
}

/**
 * Extend a share's lifetime (owner-only). Sets a fresh window of `ttlSeconds`
 * from now, clamped to the hard `maxTtl` ceiling, and re-arms the KV
 * `expirationTtl` so the metadata row survives that long. Owner-token gated —
 * possessing the global upload secret never renews another tenant's share.
 */
async function handleRenew(request: Request, env: Env, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  if (!meta) return json({ error: "not found" }, 404)
  if (meta.expiresAt && Date.now() >= meta.expiresAt) {
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  if (!(await isShareOwner(request, meta, env))) return json({ error: "unauthorized" }, 401)

  let body: { ttlSeconds?: number }
  try {
    body = JSON.parse(await request.text())
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const requested =
    typeof body.ttlSeconds === "number" && body.ttlSeconds > 0 ? body.ttlSeconds : undefined
  if (!requested) return json({ error: "ttlSeconds required" }, 400)

  const ttl = Math.min(requested, maxTtlSeconds(env))
  const expiresAt = Date.now() + ttl * 1000
  const updated: ShareMeta = { ...meta, expiresAt }
  await env.SHARE_KV.put(`meta:${code}`, JSON.stringify(updated), {
    expirationTtl: Math.max(ttl, KV_MIN_TTL_SECONDS),
  })
  return json({ expiresAt })
}

async function handleDelete(request: Request, env: Env, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  // Already gone (expired / burned / never existed) → idempotent success
  // without leaking existence or requiring a credential.
  if (!meta) return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (meta.expiresAt && Date.now() >= meta.expiresAt) {
    await deleteShare(env, code, meta.orgId)
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (!(await isShareOwner(request, meta, env))) return json({ error: "unauthorized" }, 401)
  await deleteShare(env, code, meta.orgId)
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/**
 * One org's live shares — ADR-0149 §8. Grant-only.
 *
 * The legacy upload secret is deliberately not honoured here: it says nothing
 * about which org is asking, so accepting it would let any holder list every
 * tenant's links, which is the exact failure the ADR names.
 */
async function handleListOrgShares(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = await grantCaller(request, env)
  // A grant for a different org is refused exactly like no grant at all — a
  // distinguishable "wrong org" would confirm the org in the path exists.
  if (caller?.orgId !== orgId) return json({ error: "unauthorized" }, 401)

  const index = await env.SHARE_KV.list({ prefix: `org:${orgId}:`, limit: 500 })
  const codes = index.keys.map((key) => key.name.slice(`org:${orgId}:`.length))
  const now = Date.now()
  const shares = []
  for (const code of codes) {
    const meta = await readMeta(env, code)
    // A dangling index entry — KV is eventually consistent — is skipped, never
    // reported as a share that still exists.
    if (!meta || meta.orgId !== orgId) continue
    if (meta.expiresAt && now >= meta.expiresAt) continue
    // No owner token and no envelope: a listing is for deciding what to
    // revoke, and handing back the per-share secret would turn a read into a
    // grant.
    shares.push({
      code,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      maxViews: meta.maxViews,
      viewCount: meta.viewCount,
      creatorUserId: meta.creatorUserId,
    })
  }
  shares.sort((left, right) => right.createdAt - left.createdAt)
  return json({ shares })
}

/** Revoke one of an org's shares without holding its owner token. */
async function handleDeleteOrgShare(
  request: Request,
  env: Env,
  orgId: string,
  code: string
): Promise<Response> {
  const caller = await grantCaller(request, env)
  if (caller?.orgId !== orgId) return json({ error: "unauthorized" }, 401)

  const meta = await readMeta(env, code)
  // A code in another org answers exactly like a code that never existed:
  // anything else is an oracle for which codes are real.
  if (!meta || meta.orgId !== orgId) return json({ error: "not found" }, 404)
  await deleteShare(env, code, orgId)
  return json({ ok: true })
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
    const orgMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/shares(?:\/([^/]+))?$/)
    if (orgMatch) {
      const orgId = decodeURIComponent(orgMatch[1])
      const code = orgMatch[2] ? decodeURIComponent(orgMatch[2]) : undefined
      if (code === undefined && request.method === "GET") {
        return handleListOrgShares(request, env, orgId)
      }
      if (code !== undefined && request.method === "DELETE") {
        return handleDeleteOrgShare(request, env, orgId, code)
      }
      return json({ error: "method not allowed" }, 405)
    }

    const match = pathname.match(/^\/v1\/share\/([^/]+)(\/stats)?$/)
    if (match) {
      const code = decodeURIComponent(match[1])
      const isStats = Boolean(match[2])
      if (isStats) {
        if (request.method === "GET") return handleStats(request, env, code)
      } else if (request.method === "GET") {
        return handleRead(env, code, ctx)
      } else if (request.method === "PATCH") {
        return handleRenew(request, env, code)
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
