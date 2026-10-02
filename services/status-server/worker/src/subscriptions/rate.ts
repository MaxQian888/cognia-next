/**
 * Abuse limits for subscription signup (plan §8):
 * - per IP: `SUBSCRIBE_IP_LIMIT_PER_10MIN` attempts per fixed 10-minute
 *   window. The bucket key is an HMAC of (UTC day, IP) under
 *   `IP_BUCKET_SECRET`, so no raw IP is stored and buckets cannot be linked
 *   across days; rows expire with their window;
 * - global: `SUBSCRIBE_GLOBAL_CONFIRMATIONS_PER_HOUR` confirmation-type
 *   mails per fixed hour across all addresses;
 * - per address: one confirmation-type mail per 10 minutes, enforced on the
 *   subscriber row (`last_confirmation_sent_at`) inside its own CAS.
 */

import { HOUR_MS, MINUTE_MS } from "../../../../../lib/status/contract"
import type { Env } from "../env"
import { hmacWithSecret } from "./keys"

export const IP_WINDOW_MS = 10 * MINUTE_MS
export const EMAIL_COOLDOWN_MS = 10 * MINUTE_MS
export const DEFAULT_IP_LIMIT = 5
export const DEFAULT_GLOBAL_CONFIRMATIONS_PER_HOUR = 100

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return fallback
  const value = Number(raw.trim())
  return value > 0 ? value : fallback
}

export function ipLimit(env: Env): number {
  return positiveInt(env.SUBSCRIBE_IP_LIMIT_PER_10MIN, DEFAULT_IP_LIMIT)
}

export function globalConfirmationLimit(env: Env): number {
  return positiveInt(
    env.SUBSCRIBE_GLOBAL_CONFIRMATIONS_PER_HOUR,
    DEFAULT_GLOBAL_CONFIRMATIONS_PER_HOUR
  )
}

/** The client IP as Cloudflare reports it; requests without one share a bucket. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown"
}

async function increment(db: D1Database, bucket: string, expiresAtMs: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_buckets (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT (bucket) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(bucket, expiresAtMs)
    .first<{ count: number }>()
  return row?.count ?? Number.MAX_SAFE_INTEGER
}

/** Count this attempt; true when the IP is still within its limit. */
export async function takeIpAttempt(env: Env, request: Request, nowMs: number): Promise<boolean> {
  const secret = env.IP_BUCKET_SECRET
  if (!secret) return false
  const day = new Date(nowMs).toISOString().slice(0, 10)
  const window = Math.floor(nowMs / IP_WINDOW_MS)
  const digest = await hmacWithSecret(secret, `${day}\n${clientIp(request)}`)
  const count = await increment(env.DB, `ip:${digest}:${window}`, (window + 1) * IP_WINDOW_MS)
  return count <= ipLimit(env)
}

/**
 * Reserve one confirmation-type mail from the hourly global budget. The
 * reservation is not refunded if the caller's write then loses a race:
 * erring towards sending less is the safe direction.
 */
export async function reserveGlobalConfirmation(env: Env, nowMs: number): Promise<boolean> {
  const hour = Math.floor(nowMs / HOUR_MS)
  const row = await env.DB.prepare(
    `INSERT INTO rate_buckets (bucket, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT (bucket) DO UPDATE SET count = count + 1 WHERE rate_buckets.count < ?
     RETURNING count`
  )
    .bind(`global:confirm:${hour}`, (hour + 1) * HOUR_MS, globalConfirmationLimit(env))
    .first<{ count: number }>()
  return row !== null && row.count <= globalConfirmationLimit(env)
}
