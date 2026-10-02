/**
 * Shared fixtures for owner E's Worker tests (incidents, maintenance,
 * subscriptions, notifications, admin). Test-only: nothing in `src/index.ts`
 * imports this file, so it never reaches the deployed bundle.
 */

import { env } from "cloudflare:test"

import { bytesToBase64Url } from "../../../../../lib/status/signing"
import type { Env } from "../env"
import { createRequestContext, type RequestContext } from "../platform/http"
import { acquireLease, type JobLease } from "../platform/lease"
import type { ComponentEvaluation, JobContext } from "../seams"
import { emailHmacs, encKeyRing, encryptEmail, hmacKeyRing } from "../subscriptions/keys"

export const baseEnv = env as unknown as Env

/** 2026-10-02T10:00:00.000Z — a fixed, minute-aligned clock for logic tests. */
export const T0 = Date.UTC(2026, 9, 2, 10, 0, 0)
export const MINUTE = 60_000

const OWNER_E_TABLES = [
  "incident_updates",
  "incidents",
  "maintenance_updates",
  "maintenance",
  "outbox",
  "notification_events",
  "subscriber_tokens",
  "subscribers",
  "rate_buckets",
  "operator_alerts",
  "admin_operations",
  "audit_events",
  "dirty_hours",
]

export async function resetOwnerE(db: D1Database = baseEnv.DB): Promise<void> {
  await db.batch([
    ...OWNER_E_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare("UPDATE leases SET owner = NULL, fence = 0, expires_at = 0"),
  ])
}

export async function jobAt(
  job: string,
  nowMs: number,
  testEnv: Env = baseEnv
): Promise<JobContext> {
  const lease = await acquireLease(testEnv.DB, job, nowMs)
  if (!lease) throw new Error(`lease ${job} unavailable`)
  return { env: testEnv, lease, nowMs }
}

/** Make the lease row look taken over by another runner (lease loss). */
export async function stealLease(lease: JobLease, db: D1Database = baseEnv.DB): Promise<void> {
  await db
    .prepare("UPDATE leases SET owner = 'someone-else', fence = fence + 1 WHERE job = ?")
    .bind(lease.job)
    .run()
}

export function evaluation(
  overrides: Partial<ComponentEvaluation> & { failures?: number; passes?: number } = {}
): ComponentEvaluation {
  const { failures = 0, passes = 0, ...rest } = overrides
  return {
    componentId: "signalingAuth",
    evaluatedAtMs: T0,
    status: failures >= 3 ? "major_outage" : "operational",
    confidence: "single_witness",
    inMaintenance: false,
    referenceFresh: true,
    referenceProbeId: "ext-1",
    referenceRecent: [],
    referenceStreaks: { failures, passes, failuresBeforePasses: 0 },
    latestEvidenceAtMs: T0 - MINUTE,
    witnesses: [],
    latencyDegraded: false,
    ...rest,
  }
}

export function context(request: Request, nowMs: number): RequestContext {
  return createRequestContext(request, { waitUntil: () => {} }, nowMs)
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

export async function count(table: string, where = "1 = 1", ...params: unknown[]): Promise<number> {
  const row = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>()
  return row?.n ?? 0
}

// ---------------------------------------------------------------------------
// Cloudflare Email Sending fake
// ---------------------------------------------------------------------------

export interface SentMail {
  to: string
  subject: string
  text: string
  html: string
  from: unknown
}

export type FakeBehavior =
  | { kind: "accept" }
  | { kind: "throw"; code?: string }
  | { kind: "hang" }
  | { kind: "custom"; run: (message: SentMail) => Promise<{ messageId: string }> }

export function fakeEmail(
  behavior: FakeBehavior = { kind: "accept" }
): SendEmail & { sent: SentMail[]; behavior: FakeBehavior } {
  const fake = {
    sent: [] as SentMail[],
    behavior,
    async send(message: unknown): Promise<EmailSendResult> {
      const mail = message as SentMail
      fake.sent.push(mail)
      const current = fake.behavior
      switch (current.kind) {
        case "accept":
          return { messageId: `msg-${fake.sent.length}` }
        case "throw": {
          const error = new Error("send failed") as Error & { code?: string }
          if (current.code) error.code = current.code
          throw error
        }
        case "hang":
          return new Promise<EmailSendResult>(() => {})
        case "custom":
          return current.run(mail)
      }
    },
  }
  return fake as unknown as SendEmail & { sent: SentMail[]; behavior: FakeBehavior }
}

export function emailEnv(email: SendEmail, overrides: Partial<Env> = {}): Env {
  return { ...baseEnv, EMAIL: email, ...overrides }
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWTs (test key pair + JWKS served through a fetch stub)
// ---------------------------------------------------------------------------

export const ACCESS_TEAM = "https://cognia-test.cloudflareaccess.com"
export const ACCESS_AUD = "test-access-aud"
export const OPERATOR = "operator@cognia.test"

export interface AccessKeys {
  kid: string
  privateKey: CryptoKey
  jwk: JsonWebKey & { kid: string }
}

export async function accessKeys(kid = "test-kid-1"): Promise<AccessKeys> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  return { kid, privateKey: pair.privateKey, jwk: { ...exported, kid, alg: "RS256", use: "sig" } }
}

function b64json(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

export async function signAccessJwt(
  keys: AccessKeys,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const head = b64json({ alg: "RS256", kid: keys.kid, typ: "JWT", ...header })
  const body = b64json({
    iss: ACCESS_TEAM,
    aud: [ACCESS_AUD],
    email: OPERATOR,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    sub: "operator-sub",
    ...claims,
  })
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  )
  return `${head}.${body}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/** A fetch implementation serving the JWKS for the configured team domain. */
export function jwksFetch(keys: AccessKeys[], counter?: { calls: number }) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === `${ACCESS_TEAM}/cdn-cgi/access/certs`) {
      if (counter) counter.calls += 1
      return new Response(JSON.stringify({ keys: keys.map((key) => key.jwk) }), {
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Authenticated operator API calls
// ---------------------------------------------------------------------------

/** A token valid at `nowMs` (the request clock the handler checks against). */
export async function operatorToken(
  keys: AccessKeys,
  nowMs: number,
  claims: Record<string, unknown> = {}
): Promise<string> {
  const seconds = Math.floor(nowMs / 1000)
  return signAccessJwt(keys, { iat: seconds, nbf: seconds, exp: seconds + 600, ...claims })
}

export function operationId(label = "op"): string {
  return `${label}-${crypto.randomUUID()}`
}

export async function adminCall(
  handler: (request: Request, env: Env, ctx: RequestContext) => Promise<Response | null>,
  input: {
    keys: AccessKeys
    nowMs: number
    method: "GET" | "POST" | "PUT" | "DELETE"
    path: string
    body?: unknown
    env?: Env
    token?: string | null
    host?: string
  }
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" })
  const token =
    input.token === undefined ? await operatorToken(input.keys, input.nowMs) : input.token
  if (token) headers.set("cf-access-jwt-assertion", token)
  const request = new Request(`https://${input.host ?? "status.test"}/api/status/v1${input.path}`, {
    method: input.method,
    headers,
    body:
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? input.body
          : JSON.stringify(input.body),
  })
  const response = await handler(request, input.env ?? baseEnv, context(request, input.nowMs))
  if (!response) throw new Error(`no route for ${input.method} ${input.path}`)
  return response
}

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

export async function seedSubscriber(
  id: string,
  state: "pending" | "confirmed" | "unsubscribed" | "suppressed",
  opts: {
    email?: string
    componentIds?: string[]
    locale?: "en" | "zh-CN"
    confirmedAtMs?: number
    consentVersion?: number
  } = {}
): Promise<string> {
  const email = opts.email ?? `${id}@example.com`
  const [hmac] = await emailHmacs(hmacKeyRing(baseEnv)!, email)
  const sealed = await encryptEmail(encKeyRing(baseEnv)!, id, email)
  await baseEnv.DB.prepare(
    `INSERT INTO subscribers (id, email_hmac, email_hmac_key_id, email_ciphertext, email_key_id, state, locale,
       component_ids_json, consent_version, consent_terms_version, preference_revision, created_at, pending_since,
       confirmed_at, updated_at, last_confirmation_sent_at, suppressed_reason, purge_after, write_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
  )
    .bind(
      id,
      hmac!.hmac,
      hmac!.keyId,
      sealed.ciphertext,
      sealed.keyId,
      state,
      opts.locale ?? "en",
      JSON.stringify(opts.componentIds ?? []),
      opts.consentVersion ?? 1,
      T0 - 60 * MINUTE,
      state === "pending" ? T0 : null,
      state === "confirmed" ? (opts.confirmedAtMs ?? T0 - 60 * MINUTE) : null,
      T0 - 60 * MINUTE
    )
    .run()
  return email
}
