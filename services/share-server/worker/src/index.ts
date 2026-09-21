import { DurableObject } from "cloudflare:workers"

// Cloudflare Worker for the cognia public share service (zero-knowledge).
//
// The Worker is a blind store: it holds opaque AES-GCM envelopes in R2 and
// per-share lifecycle counters in Durable Objects. It never sees the decryption key (that
// rides in the URL #fragment, which browsers never send to the server) and the
// payload's kind/mime live inside the ciphertext. Writes and deletes require a
// bearer secret the owner configures; reads are public but lifecycle-gated
// (TTL, max-views, burn-after-read, revoke).
//
// This deliberately mirrors the signaling worker's posture: free-tier friendly
// (R2 + KV + SQLite-backed Durable Objects), one custom domain, observability on. It is a separate Node project
// (own package.json + lockfile), not part of the app's pnpm workspace.

export interface Env {
  /** Opaque envelope bodies, keyed `share/<code>`. */
  SHARE_BUCKET: R2Bucket
  /** Legacy metadata and eventually consistent org discovery index. */
  SHARE_KV: KVNamespace
  /** Mandatory per-share lifecycle authority. */
  SHARE_LIFECYCLE: DurableObjectNamespace<ShareLifecycle>
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

type LifecycleEnv = Env & { lifecycleStorage: DurableObjectStorage }

async function stageCleanup(env: LifecycleEnv, code: string, orgId?: string): Promise<void> {
  // Persist intent before external I/O so interrupted creation/deletion is recoverable.
  await env.lifecycleStorage.transaction(async (tx) => {
    await tx.put({ meta: null, cleanup: { code, orgId } })
    await tx.setAlarm(Date.now() + 1000)
  })
}

async function deleteShare(env: LifecycleEnv, code: string, orgId?: string): Promise<void> {
  await stageCleanup(env, code, orgId)
  await cleanupShare(env, code, orgId)
}

async function cleanupShare(env: LifecycleEnv, code: string, orgId?: string): Promise<void> {
  await Promise.all([
    env.SHARE_BUCKET.delete(`share/${code}`),
    env.SHARE_KV.delete(`meta:${code}`),
    orgId ? env.SHARE_KV.delete(orgIndexKey(orgId, code)) : Promise.resolve(),
  ])
  await env.lifecycleStorage.transaction(async (tx) => {
    await tx.delete("cleanup")
    await tx.deleteAlarm()
  })
}

async function writeMeta(env: LifecycleEnv, code: string, meta: ShareMeta): Promise<void> {
  await env.lifecycleStorage.transaction(async (tx) => {
    await tx.put({ meta, code })
    await tx.delete("cleanup")
    if (meta.expiresAt !== undefined) await tx.setAlarm(Math.max(Date.now() + 1, meta.expiresAt))
  })
}

async function updateOrgIndex(env: Env, code: string, meta: ShareMeta): Promise<void> {
  if (!meta.orgId) return
  const ttl =
    meta.expiresAt === undefined
      ? undefined
      : Math.max(KV_MIN_TTL_SECONDS, Math.ceil((meta.expiresAt - Date.now()) / 1000))
  await env.SHARE_KV.put(orgIndexKey(meta.orgId, code), "", ttl ? { expirationTtl: ttl } : {})
}

async function handleCreate(request: Request, env: LifecycleEnv, code: string): Promise<Response> {
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
  if (!body || !looksLikeEnvelope(body.envelope)) return json({ error: "invalid envelope" }, 400)

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

  await stageCleanup(env, code, meta.orgId)
  await env.SHARE_BUCKET.put(`share/${code}`, JSON.stringify(body.envelope), {
    httpMetadata: { contentType: "application/json" },
  })
  await updateOrgIndex(env, code, meta)
  // Publish only after external writes; commit clears cleanup and arms the TTL.
  await writeMeta(env, code, meta)

  return json({ code, ownerToken, expiresAt }, 201)
}

async function readMeta(env: LifecycleEnv, _code: string): Promise<ShareMeta | null> {
  return (await env.lifecycleStorage.get<ShareMeta | null>("meta")) ?? null
}

function unavailable(meta: ShareMeta, now = Date.now()): boolean {
  return (
    meta.revoked ||
    (meta.expiresAt !== undefined && now >= meta.expiresAt) ||
    (meta.maxViews !== undefined && meta.viewCount >= meta.maxViews)
  )
}

async function handleRead(env: LifecycleEnv, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  if (!meta) return json({ error: "not found" }, 404)
  if (unavailable(meta)) {
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  const object = await env.SHARE_BUCKET.get(`share/${code}`)
  if (!object) {
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  const envelopeText = await object.text()
  // R2 I/O can cross expiry even while other lifecycle requests are queued.
  if (unavailable(meta)) {
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  const nextCount = meta.viewCount + 1
  if (meta.maxViews !== undefined && nextCount >= meta.maxViews) {
    await deleteShare(env, code, meta.orgId)
  } else {
    // Counter-only writes retain the existing expiry alarm and org index.
    await env.lifecycleStorage.put("meta", { ...meta, viewCount: nextCount })
  }
  return new Response(`{"envelope":${envelopeText}}`, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  })
}

async function handleStats(request: Request, env: LifecycleEnv, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  // Ownership is checked against the share's own token, so a missing share is
  // a 404 regardless of credentials (no oracle for which codes exist).
  if (!meta) return json({ error: "not found" }, 404)
  if (unavailable(meta)) {
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
 * from now, clamped to the hard `maxTtl` ceiling, and re-arms its durable
 * expiry alarm and org discovery index. Owner-token gated —
 * possessing the global upload secret never renews another tenant's share.
 */
async function handleRenew(request: Request, env: LifecycleEnv, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  if (!meta) return json({ error: "not found" }, 404)
  if (unavailable(meta)) {
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
    body &&
    typeof body === "object" &&
    typeof body.ttlSeconds === "number" &&
    Number.isFinite(body.ttlSeconds) &&
    body.ttlSeconds > 0
      ? body.ttlSeconds
      : undefined
  if (!requested) return json({ error: "ttlSeconds required" }, 400)

  const ttl = Math.min(requested, maxTtlSeconds(env))
  const expiresAt = Date.now() + ttl * 1000
  const updated: ShareMeta = { ...meta, expiresAt }
  if (unavailable(meta)) {
    await deleteShare(env, code, meta.orgId)
    return json({ error: "not found" }, 404)
  }
  await writeMeta(env, code, updated)
  await updateOrgIndex(env, code, updated)
  return json({ expiresAt })
}

async function handleDelete(request: Request, env: LifecycleEnv, code: string): Promise<Response> {
  const meta = await readMeta(env, code)
  // Already gone (expired / burned / never existed) → idempotent success
  // without leaking existence or requiring a credential.
  if (!meta) return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (unavailable(meta)) {
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
  const shares: Array<Record<string, unknown> & { createdAt: number }> = []
  for (let offset = 0; offset < index.keys.length; offset += 16) {
    const batch = await Promise.all(
      index.keys.slice(offset, offset + 16).map(async (key) => {
        const code = key.name.slice(`org:${orgId}:`.length)
        const response = await lifecycleRequest(request, env, code, "org-list", orgId)
        if (response.status === 404) return null
        if (!response.ok) return response
        return response.json<Record<string, unknown> & { createdAt: number }>()
      })
    )
    for (const share of batch) {
      if (share instanceof Response) return share
      if (share) shares.push(share)
    }
  }
  shares.sort((left, right) => right.createdAt - left.createdAt)
  return json({ shares })
}

/** Revoke one of an org's shares without holding its owner token. */
async function handleDeleteOrgShare(
  request: Request,
  env: LifecycleEnv,
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

async function lifecycleRequest(
  request: Request,
  env: Env,
  code: string,
  action: string,
  orgId?: string
): Promise<Response> {
  if (!env.SHARE_LIFECYCLE) return json({ error: "share lifecycle unavailable" }, 503)
  const url = new URL(`https://lifecycle.internal/${encodeURIComponent(code)}`)
  url.searchParams.set("action", action)
  if (orgId !== undefined) url.searchParams.set("orgId", orgId)
  const stub = env.SHARE_LIFECYCLE.get(env.SHARE_LIFECYCLE.idFromName(code))
  try {
    return await stub.fetch(new Request(url, request))
  } catch {
    return json({ error: "share lifecycle unavailable" }, 503)
  }
}

/** One globally addressed authority per share, including migrated KV links.
 * The queue includes external I/O; every transition commits before replying.
 * Crash recovery reads committed metadata/tombstones instead of stale KV. */
export class ShareLifecycle extends DurableObject<Env> {
  private pending: Promise<unknown> = Promise.resolve()

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }

  private scopedEnv(): LifecycleEnv {
    return { ...this.env, lifecycleStorage: this.ctx.storage }
  }

  private async importLegacy(code: string): Promise<void> {
    if ((await this.ctx.storage.get("meta")) !== undefined) return
    const raw = await this.env.SHARE_KV.get(`meta:${code}`)
    // Negative KV reads must not delete valid R2 data during propagation.
    if (!raw) return
    if (new TextEncoder().encode(raw).byteLength > 64 * 1024)
      throw new Error("oversized legacy metadata")
    const meta: ShareMeta = JSON.parse(raw)
    if (
      !meta ||
      !Number.isFinite(meta.createdAt) ||
      !Number.isSafeInteger(meta.viewCount) ||
      meta.viewCount < 0 ||
      typeof meta.revoked !== "boolean" ||
      typeof meta.burnAfterRead !== "boolean" ||
      (meta.expiresAt !== undefined && !Number.isFinite(meta.expiresAt)) ||
      (meta.maxViews !== undefined &&
        (!Number.isSafeInteger(meta.maxViews) || meta.maxViews < 0)) ||
      [meta.ownerToken, meta.orgId, meta.creatorUserId].some(
        (value) => value !== undefined && typeof value !== "string"
      )
    ) {
      throw new Error("invalid legacy metadata")
    }
    await writeMeta(this.scopedEnv(), code, meta)
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      const url = new URL(request.url)
      const code = decodeURIComponent(url.pathname.slice(1))
      const action = url.searchParams.get("action")
      const env = this.scopedEnv()
      await this.importLegacy(code)
      if (action === "create") {
        if ((await this.ctx.storage.get("meta")) !== undefined)
          return json({ error: "code collision" }, 409)
        return handleCreate(request, env, code)
      }
      if (action === "read") return handleRead(env, code)
      if (action === "stats") return handleStats(request, env, code)
      if (action === "renew") return handleRenew(request, env, code)
      if (action === "delete") return handleDelete(request, env, code)
      const orgId = url.searchParams.get("orgId") ?? ""
      if (action === "org-delete") return handleDeleteOrgShare(request, env, orgId, code)
      if (action === "org-list") {
        const caller = await grantCaller(request, env)
        if (caller?.orgId !== orgId) return json({ error: "unauthorized" }, 401)
        const meta = await readMeta(env, code)
        if (!meta || meta.orgId !== orgId || unavailable(meta))
          return json({ error: "not found" }, 404)
        return json({
          code,
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
          maxViews: meta.maxViews,
          viewCount: meta.viewCount,
          creatorUserId: meta.creatorUserId,
        })
      }
      return json({ error: "not found" }, 404)
    })
  }

  alarm(): Promise<void> {
    return this.serial(async () => {
      const env = this.scopedEnv()
      const cleanup = await this.ctx.storage.get<{ code: string; orgId?: string }>("cleanup")
      if (cleanup) {
        await cleanupShare(env, cleanup.code, cleanup.orgId)
        return
      }
      const code = await this.ctx.storage.get<string>("code")
      const meta = await this.ctx.storage.get<ShareMeta | null>("meta")
      if (!code || !meta) return
      if (unavailable(meta)) await deleteShare(env, code, meta.orgId)
      else if (meta.expiresAt !== undefined) await this.ctx.storage.setAlarm(meta.expiresAt)
    })
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const { pathname } = url

    // API surface.
    if (pathname === "/v1/share" && request.method === "POST") {
      return lifecycleRequest(request, env, generateCode(), "create")
    }
    const orgMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/shares(?:\/([^/]+))?$/)
    if (orgMatch) {
      const orgId = decodeURIComponent(orgMatch[1])
      const code = orgMatch[2] ? decodeURIComponent(orgMatch[2]) : undefined
      if (code === undefined && request.method === "GET") {
        return handleListOrgShares(request, env, orgId)
      }
      if (code !== undefined && request.method === "DELETE") {
        return lifecycleRequest(request, env, code, "org-delete", orgId)
      }
      return json({ error: "method not allowed" }, 405)
    }

    const match = pathname.match(/^\/v1\/share\/([^/]+)(\/stats)?$/)
    if (match) {
      const code = decodeURIComponent(match[1])
      const isStats = Boolean(match[2])
      if (isStats) {
        if (request.method === "GET") return lifecycleRequest(request, env, code, "stats")
      } else if (request.method === "GET") {
        return lifecycleRequest(request, env, code, "read")
      } else if (request.method === "PATCH") {
        return lifecycleRequest(request, env, code, "renew")
      } else if (request.method === "DELETE") {
        return lifecycleRequest(request, env, code, "delete")
      }
      return json({ error: "method not allowed" }, 405)
    }

    // Everything else is not ours. The viewer is now the app's own
    // `/share/view` route served by Cloudflare Pages (ADR-0037 Phase 4); this
    // Worker is a pure JSON API scoped to `/v1/*`.
    return json({ error: "not found" }, 404)
  },
} satisfies ExportedHandler<Env>
