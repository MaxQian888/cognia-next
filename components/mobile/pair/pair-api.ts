"use client"

import { pinnedFetch as defaultPinnedFetch, type PinnedFetchInit } from "@/lib/tauri/pinned-fetch"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"

import { getDeviceLabel, getDevicePlatform, safeText } from "./pair-helpers"

/**
 * Mobile-side wrappers for the two pair-redeem endpoints on the desktop
 * companion server. Extracted from `pair-step.tsx` so the step UI can
 * dispatch by tab (QR/manual vs. 6-digit code) without inlining two
 * copies of the redeem dance, and so this layer is unit-testable.
 *
 * The Rust side lives in `src-tauri/src/companion_api/auth.rs`:
 *
 *   - `POST /api/v1/auth/pair`            → [`redeemPairJwt`]
 *   - `POST /api/v1/auth/pair/redeem-code`→ [`redeemPairCode`]
 *
 * Both endpoints share the same shared redeem core on the server, so
 * both return identical [`PairResponseBody`] shapes — the wrappers
 * collapse to the same `RedeemResult`.
 */

/** Wire-format response from `/api/v1/auth/pair` and `/redeem-code`. */
export interface PairResponseBody {
  device_id: string
  device_jwt: string
  server_version: string
  /** ADR-0021 — optional for legacy desktops without WebRTC support. */
  rendezvous_id?: string
  /** ADR-0021 — 32-byte HMAC secret, URL-safe base64 (unpadded). */
  rendezvous_secret?: string
}

export interface PairCommonOptions {
  baseUrl: string
  deviceLabel?: string
  devicePlatform?: string
  devicePubkey?: string
  appVersion?: string
  /** SPKI hex fingerprint pinned out-of-band (QR payload). When present
   *  the request is sent through `serverTrustMode: "pinned"`. */
  serverFingerprint?: string
}

export interface RedeemJwtOptions extends PairCommonOptions {
  pairJwt: string
}

export interface RedeemCodeOptions extends PairCommonOptions {
  /** 6-digit numeric code displayed on the desktop PairDeviceCard. */
  code: string
}

/** Result discriminated union — `ok` carries the persisted
 *  `CompanionConfig`; `error` carries a normalised error code the UI can
 *  map to localised copy. */
export type RedeemResult =
  | { kind: "ok"; body: PairResponseBody; config: CompanionConfig }
  | { kind: "http_error"; status: number; rawBody: string }
  | { kind: "network_error"; message: string }
  | {
      kind: "code_error"
      code: "pair_code_not_found" | "pair_code_expired" | "invalid_pair_code" | "malformed_request"
      message: string
    }

/** Test seam — both wrappers accept a `pinnedFetch` injection so unit
 *  tests can avoid touching the real Capacitor plugin. */
export type PairFetcher = (url: string, init: PinnedFetchInit) => Promise<Response>

export async function redeemPairJwt(
  opts: RedeemJwtOptions,
  fetcher: PairFetcher = defaultPinnedFetch
): Promise<RedeemResult> {
  const url = `${trimSlash(opts.baseUrl)}/api/v1/auth/pair`
  return runRedeem(
    url,
    {
      pair_jwt: opts.pairJwt,
      device_label: opts.deviceLabel ?? getDeviceLabel(),
      device_platform: opts.devicePlatform ?? getDevicePlatform(),
      device_pubkey: opts.devicePubkey ?? "",
      app_version: opts.appVersion ?? "0.1.0",
    },
    opts,
    fetcher
  )
}

export async function redeemPairCode(
  opts: RedeemCodeOptions,
  fetcher: PairFetcher = defaultPinnedFetch
): Promise<RedeemResult> {
  const trimmedCode = opts.code.trim()
  if (trimmedCode.length !== 6 || !/^\d{6}$/.test(trimmedCode)) {
    return {
      kind: "code_error",
      code: "invalid_pair_code",
      message: "pair code must be exactly 6 digits",
    }
  }
  const url = `${trimSlash(opts.baseUrl)}/api/v1/auth/pair/redeem-code`
  return runRedeem(
    url,
    {
      code: trimmedCode,
      device_label: opts.deviceLabel ?? getDeviceLabel(),
      device_platform: opts.devicePlatform ?? getDevicePlatform(),
      device_pubkey: opts.devicePubkey ?? "",
      app_version: opts.appVersion ?? "0.1.0",
    },
    opts,
    fetcher
  )
}

async function runRedeem(
  url: string,
  payload: Record<string, string>,
  common: PairCommonOptions,
  fetcher: PairFetcher
): Promise<RedeemResult> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      serverFingerprint: common.serverFingerprint || undefined,
    })
  } catch (err) {
    return {
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!response.ok) {
    const rawBody = await safeText(response)
    // The Rust handler returns flat `{ code, message }` envelopes
    // (Wave 3.1). Map the well-known pair_code_* codes onto our
    // discriminated union so the UI can show localised copy without
    // re-parsing strings.
    const parsed = tryParseFlatError(rawBody)
    if (parsed && isKnownCodeError(parsed.code)) {
      return {
        kind: "code_error",
        code: parsed.code,
        message: parsed.message,
      }
    }
    return { kind: "http_error", status: response.status, rawBody }
  }

  const body = (await response.json()) as PairResponseBody
  const config: CompanionConfig = {
    baseUrl: trimSlash(common.baseUrl),
    deviceJwt: body.device_jwt,
    deviceId: body.device_id,
    serverVersion: body.server_version,
  }
  if (common.serverFingerprint) {
    config.serverFingerprint = common.serverFingerprint
  }
  if (body.rendezvous_id && body.rendezvous_secret) {
    config.rendezvousId = body.rendezvous_id
    config.rendezvousSecret = body.rendezvous_secret
  }
  return { kind: "ok", body, config }
}

function isKnownCodeError(
  code: string
): code is "pair_code_not_found" | "pair_code_expired" | "invalid_pair_code" | "malformed_request" {
  return (
    code === "pair_code_not_found" ||
    code === "pair_code_expired" ||
    code === "invalid_pair_code" ||
    code === "malformed_request"
  )
}

function tryParseFlatError(raw: string): { code: string; message: string } | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.code !== "string") return null
    return {
      code: obj.code,
      message: typeof obj.message === "string" ? obj.message : "",
    }
  } catch {
    return null
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}
