/**
 * Whether email signup can be offered right now. Every input must be
 * present; a missing one turns the capability off rather than degrading it:
 * - `FEATURE_EMAIL = "on"`;
 * - the Cloudflare Email Sending binding `EMAIL`;
 * - a sender (`MAIL_FROM`);
 * - subscriber HMAC and encryption keys with valid current key IDs;
 * - the IP bucket secret (abuse limits cannot run without it);
 * - at least one allowed Origin for signup posts.
 * Off: `POST /subscriptions` answers 503 `unavailable`, no outbox row is
 * created and delivery sends nothing (queued rows stay pending).
 */

import { featureOn, type Env } from "../env"
import { subscriberKeysConfigured } from "./keys"

export function allowedOrigins(env: Env): string[] {
  return (env.SUBSCRIBE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

export function mailSender(env: Env): { email: string; name: string } | null {
  const email = env.MAIL_FROM?.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return { email, name: env.MAIL_FROM_NAME?.trim() || "Cognia Status" }
}

export function emailCapability(env: Env): boolean {
  return (
    featureOn(env.FEATURE_EMAIL) &&
    env.EMAIL !== undefined &&
    env.EMAIL !== null &&
    mailSender(env) !== null &&
    subscriberKeysConfigured(env) &&
    Boolean(env.IP_BUCKET_SECRET && env.IP_BUCKET_SECRET.length >= 16) &&
    allowedOrigins(env).length > 0
  )
}
