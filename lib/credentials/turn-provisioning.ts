"use client"

/**
 * Automatic ephemeral-TURN credential provisioning. ADR-0021.
 *
 * Instead of hand-pasted static `turn:` lines that never rotate, the user
 * configures a TURN-as-a-service provider once (Cloudflare Calls / Twilio
 * NTS) and the app mints short-lived ICE servers on demand, rotating them
 * before expiry (see `turn-provisioning-cache.ts`). Desktop and mobile each
 * provision independently — TURN allocations are per-credential, so the two
 * peers using different ephemeral creds against the same TURN server relay
 * to each other normally.
 *
 * Both provider endpoints are public HTTPS, so a plain `fetch` works in the
 * Tauri webview and the Capacitor WebView alike — no `CapacitorHttp` needed.
 * The provider API secret lives in the OS keyring (`keyring-store.ts`,
 * namespace `webrtc-turn-provider`), never in Dexie, and is never included
 * in any thrown error message.
 *
 * Verified API contracts (2026-06):
 *   - Cloudflare Realtime/Calls TURN — `POST
 *     https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`,
 *     `Authorization: Bearer <token>`, body `{ ttl }` → 201 `{ iceServers }`.
 *   - Twilio Network Traversal — `POST
 *     https://api.twilio.com/2010-04-01/Accounts/{sid}/Tokens.json`,
 *     HTTP Basic `sid:authToken`, form `Ttl=<n>` → `{ ttl, ice_servers }`
 *     (entries may use legacy `url` or plural `urls`).
 */

import type { TurnProviderConfig } from "@cognia/agent-config-types"
import { createKeyringStore, type KeyringStore } from "./keyring-store"
import { keyIdOfSentinel } from "./turn-credentials"

const PROVIDER_KEYRING_NAMESPACE = "webrtc-turn-provider"

export const TTL_MIN_SECONDS = 600
export const TTL_MAX_SECONDS = 86400
export const TTL_DEFAULT_SECONDS = 86400

/** Clamp a requested TTL into the provider-supported window. */
export function clampTtl(ttlSeconds?: number): number {
  const n =
    typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) ? ttlSeconds : TTL_DEFAULT_SECONDS
  return Math.min(TTL_MAX_SECONDS, Math.max(TTL_MIN_SECONDS, Math.round(n)))
}

/** Provider API secret — shape depends on `TurnProviderConfig.kind`. */
export type TurnProviderSecret = { apiToken: string } | { authToken: string }

export class TurnProvisionError extends Error {
  override name = "TurnProvisionError"
  constructor(
    public readonly reason: string,
    public readonly status?: number
  ) {
    super(`turn provisioning failed: ${reason}${status ? ` (status ${status})` : ""}`)
  }
}

// ---------------------------------------------------------------------------
// Provider secret keyring
// ---------------------------------------------------------------------------

let providerStore: KeyringStore | null = null
function store(): KeyringStore {
  if (!providerStore) providerStore = createKeyringStore(PROVIDER_KEYRING_NAMESPACE)
  return providerStore
}

/** Test seam — overrides the provider-secret keyring backend. */
export function __setProviderSecretStore(s: KeyringStore | null): void {
  providerStore = s
}

export async function saveProviderSecret(keyId: string, secret: TurnProviderSecret): Promise<void> {
  await store().save(keyId, JSON.stringify(secret))
}

export async function loadProviderSecret(keyId: string): Promise<TurnProviderSecret | null> {
  const raw = await store().load(keyId)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TurnProviderSecret>
    if (typeof (parsed as { apiToken?: unknown }).apiToken === "string") {
      return { apiToken: (parsed as { apiToken: string }).apiToken }
    }
    if (typeof (parsed as { authToken?: unknown }).authToken === "string") {
      return { authToken: (parsed as { authToken: string }).authToken }
    }
    return null
  } catch {
    return null
  }
}

export async function deleteProviderSecret(keyId: string): Promise<void> {
  await store().delete(keyId)
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  iceServers: RTCIceServer[]
  /** Epoch ms after which the credentials are no longer valid. */
  expiresAt: number
}

export interface ProvisionOptions {
  /** Test seam — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to `Date.now`. */
  nowMs?: () => number
  /** Test seam — defaults to `loadProviderSecret`. */
  loadSecret?: (keyId: string) => Promise<TurnProviderSecret | null>
}

/** Normalize Twilio's `ice_servers` (legacy `url` or plural `urls`) into
 *  `RTCIceServer[]`. Entries without any url are dropped. */
export function normalizeTwilioIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return []
  const out: RTCIceServer[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as { url?: unknown; urls?: unknown; username?: unknown; credential?: unknown }
    const urls = e.urls ?? e.url
    if (typeof urls !== "string" && !Array.isArray(urls)) continue
    const server: RTCIceServer = { urls: urls as string | string[] }
    if (typeof e.username === "string") server.username = e.username
    if (typeof e.credential === "string") server.credential = e.credential
    out.push(server)
  }
  return out
}

/**
 * Mint a fresh set of ICE servers from the configured provider. Throws
 * `TurnProvisionError` on a missing secret, an unsupported `kind`, or a
 * non-2xx response. The provider secret never appears in the error.
 */
export async function provisionIceServers(
  provider: TurnProviderConfig,
  opts: ProvisionOptions = {}
): Promise<ProvisionResult> {
  if (provider.kind === "none") {
    throw new TurnProvisionError("provider-none")
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const now = opts.nowMs ?? Date.now
  const loadSecret = opts.loadSecret ?? loadProviderSecret

  const keyId = provider.secretRef ? keyIdOfSentinel(provider.secretRef) : null
  if (!keyId) throw new TurnProvisionError("missing-secret")
  const secret = await loadSecret(keyId)
  if (!secret) throw new TurnProvisionError("missing-secret")

  const ttl = clampTtl(provider.ttlSeconds)

  if (provider.kind === "cloudflare-calls") {
    if (!provider.cloudflareKeyId) throw new TurnProvisionError("missing-cloudflare-key-id")
    const apiToken = (secret as { apiToken?: string }).apiToken
    if (!apiToken) throw new TurnProvisionError("missing-secret")
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      provider.cloudflareKeyId
    )}/credentials/generate-ice-servers`
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    })
    if (!res.ok) throw new TurnProvisionError("cloudflare-http-error", res.status)
    const body = (await res.json()) as { iceServers?: RTCIceServer[] }
    const iceServers = Array.isArray(body.iceServers) ? body.iceServers : []
    return { iceServers, expiresAt: now() + ttl * 1000 }
  }

  // Twilio
  if (!provider.twilioAccountSid) throw new TurnProvisionError("missing-twilio-sid")
  const authToken = (secret as { authToken?: string }).authToken
  if (!authToken) throw new TurnProvisionError("missing-secret")
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    provider.twilioAccountSid
  )}/Tokens.json`
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${provider.twilioAccountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Ttl: String(ttl) }).toString(),
  })
  if (!res.ok) throw new TurnProvisionError("twilio-http-error", res.status)
  const body = (await res.json()) as { ttl?: string | number; ice_servers?: unknown }
  const iceServers = normalizeTwilioIceServers(body.ice_servers)
  const respTtl = typeof body.ttl !== "undefined" ? Number(body.ttl) : ttl
  const effectiveTtl = Number.isFinite(respTtl) && respTtl > 0 ? respTtl : ttl
  return { iceServers, expiresAt: now() + effectiveTtl * 1000 }
}
