"use client"

import { pinnedFetch as defaultPinnedFetch, type PinnedFetchInit } from "@/lib/tauri/pinned-fetch"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import {
  buildRoomDescriptorV2,
  generatePersistableV2SigningIdentity,
  type RoomDescriptorV2,
} from "@/lib/signaling/v2-crypto"

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

/**
 * Wire-format response from `/api/v1/auth/pair` and `/redeem-code`.
 *
 * The Rust `PairResponse` serializes camelCase (`deviceJwt`, …) — asserted by
 * `pair_flow_test.rs`. The snake_case variants are kept as tolerated aliases
 * because this module historically read them; `runRedeem` accepts either.
 */
export interface PairResponseBody {
  deviceId?: string
  deviceJwt?: string
  serverVersion?: string
  rendezvousId?: string
  roomDescriptor?: RoomDescriptorV2
  signalingKeyRef?: string
  /** ADR-0059 C4 — local account this pairing routes to. */
  accountId?: string
  device_id?: string
  device_jwt?: string
  server_version?: string
  rendezvous_id?: string
  room_descriptor?: RoomDescriptorV2
  signaling_key_ref?: string
  account_id?: string
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
  let signalingIdentity: Awaited<ReturnType<typeof generatePersistableV2SigningIdentity>>
  try {
    signalingIdentity = await generatePersistableV2SigningIdentity()
  } catch (error) {
    return {
      kind: "network_error",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  payload.mobile_signing_key = signalingIdentity.encodedPublicKey
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
  const deviceJwt = body.deviceJwt ?? body.device_jwt
  const deviceId = body.deviceId ?? body.device_id
  if (!deviceJwt || !deviceId) {
    return {
      kind: "http_error",
      status: response.status,
      rawBody: "pair response missing deviceJwt/deviceId",
    }
  }
  const config: CompanionConfig = {
    baseUrl: trimSlash(common.baseUrl),
    deviceJwt,
    deviceId,
    serverVersion: body.serverVersion ?? body.server_version ?? "unknown",
  }
  if (common.serverFingerprint) {
    config.serverFingerprint = common.serverFingerprint
  }
  const rendezvousId = body.rendezvousId ?? body.rendezvous_id
  const roomDescriptor = body.roomDescriptor ?? body.room_descriptor
  if (!rendezvousId || !roomDescriptor || roomDescriptor.v !== 2) {
    return {
      kind: "http_error",
      status: response.status,
      rawBody: "pair response missing signaling v2 room descriptor",
    }
  }
  const verifiedDescriptor = await buildRoomDescriptorV2({
    roomNonce: roomDescriptor.roomNonce,
    desktopSigningKey: roomDescriptor.desktopSigningKey,
    mobileSigningKey: roomDescriptor.mobileSigningKey,
    notAfter: roomDescriptor.notAfter,
  })
  if (
    verifiedDescriptor.roomId !== rendezvousId ||
    verifiedDescriptor.roomId !== roomDescriptor.roomId ||
    roomDescriptor.mobileSigningKey !== signalingIdentity.encodedPublicKey
  ) {
    return {
      kind: "http_error",
      status: response.status,
      rawBody: "pair response signaling v2 descriptor verification failed",
    }
  }
  config.rendezvousId = rendezvousId
  config.signalingRoomDescriptor = roomDescriptor
  config.signalingPrivateKeyJwk = signalingIdentity.privateKeyJwk
  config.signalingPrivateKey = signalingIdentity.privateKey
  const accountId = body.accountId ?? body.account_id
  if (accountId) {
    config.accountId = accountId
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
