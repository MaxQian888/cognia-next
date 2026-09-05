/** Offline pairing payload. Its schema version is independent of public URLs. */
import { Buffer } from "buffer"

import type { RoomDescriptor } from "@/lib/signaling/types"

/**
 * ADR-0170: the one-shot relay room a device may pair through when it cannot
 * reach `baseUrl` directly (a phone off the LAN, any browser). Mirror of
 * `PairingRoomIssue` in `src-tauri/src/companion_api/signaling/pairing.rs`.
 */
export interface PairRelay {
  /** The rendezvous the Host is sitting in. */
  url: string
  /** Self-certifying room whose desktop key the Host minted for this invitation. */
  room: RoomDescriptor
  /**
   * The mobile role's P-256 private key for this room only, as a JWK. Worth
   * exactly what the one-shot invitation next to it is worth.
   */
  mobilePrivateKeyJwk: JsonWebKey
}

export interface PairPayload {
  baseUrl: string
  mode: "owner-invitation" | "oidc"
  invitation?: string
  hostId: string
  tenantId: string
  expiresAt: number
  serverVersion: string
  fingerprint: string
  /** Present on a `cgnp4` invitation. Absent on `cgnp3` and on a Host with no relay. */
  relay?: PairRelay
}

/**
 * `cgnp3` is the pre-relay shape and stays fully supported: a Host that is not
 * sitting in a rendezvous still issues it, and an older phone still reads it.
 * `cgnp4` adds the `relay` field and nothing else, so it is emitted only when
 * there is a relay to carry.
 */
const LEGACY_PAYLOAD_VERSION = 3 as const
const PAYLOAD_VERSION = 4 as const

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function fromBase64Url(input: string): string {
  const padding = (4 - (input.length % 4)) % 4
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding),
    "base64"
  ).toString("utf8")
}

export function encodePairPayload(payload: PairPayload): string {
  const version = payload.relay ? PAYLOAD_VERSION : LEGACY_PAYLOAD_VERSION
  return (
    `cgnp${version}|` +
    toBase64Url(
      JSON.stringify({
        base: payload.baseUrl,
        host: payload.hostId,
        tenant: payload.tenantId,
        exp: payload.expiresAt,
        ver: payload.serverVersion,
        fp: payload.fingerprint,
        mode: payload.mode,
        ...(payload.mode === "owner-invitation" ? { invitation: payload.invitation } : {}),
        ...(payload.relay ? { relay: payload.relay } : {}),
      })
    )
  )
}

export type DecodeOutcome =
  | { kind: "ok"; payload: PairPayload }
  | { kind: "wrong_format" }
  | { kind: "version_mismatch"; got: number }
  | { kind: "invalid"; message: string }

export function decodePairPayload(raw: string): DecodeOutcome {
  const match = /^cgnp(\d+)\|(.+)$/.exec(raw.trim())
  if (!match) return { kind: "wrong_format" }
  const version = Number.parseInt(match[1], 10)
  if (version !== PAYLOAD_VERSION && version !== LEGACY_PAYLOAD_VERSION) {
    return { kind: "version_mismatch", got: version }
  }
  try {
    const value = JSON.parse(fromBase64Url(match[2])) as Record<string, unknown>
    const mode = stringField(value, "mode")
    if (mode !== "owner-invitation" && mode !== "oidc") {
      throw new Error("invalid mode")
    }
    const invitation = typeof value.invitation === "string" ? value.invitation : undefined
    if (mode === "owner-invitation" && !invitation) {
      throw new Error("missing invitation")
    }
    if (mode === "oidc" && invitation !== undefined) {
      throw new Error("oidc payload must not contain invitation")
    }
    const payload: PairPayload = {
      baseUrl: stringField(value, "base"),
      mode,
      invitation,
      hostId: stringField(value, "host"),
      tenantId: stringField(value, "tenant"),
      expiresAt: numberField(value, "exp"),
      serverVersion: stringField(value, "ver"),
      fingerprint: typeof value.fp === "string" ? value.fp : "",
    }
    if (version === PAYLOAD_VERSION && value.relay !== undefined) {
      payload.relay = relayField(value.relay)
    }
    if (payload.expiresAt <= Date.now()) {
      return { kind: "invalid", message: "pairing invitation has expired" }
    }
    return { kind: "ok", payload }
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) }
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) throw new Error(`missing ${key}`)
  return field
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`missing ${key}`)
  return field
}

function relayField(raw: unknown): PairRelay {
  if (!raw || typeof raw !== "object") throw new Error("invalid relay")
  const value = raw as Record<string, unknown>
  const room = value.room
  if (!room || typeof room !== "object") throw new Error("invalid relay room")
  const descriptor = room as Record<string, unknown>
  const jwk = value.mobilePrivateKeyJwk
  if (!jwk || typeof jwk !== "object") throw new Error("invalid relay key")
  const key = jwk as Record<string, unknown>
  if (key.kty !== "EC" || key.crv !== "P-256") throw new Error("invalid relay key")
  for (const part of ["d", "x", "y"]) stringField(key, part)
  return {
    url: stringField(value, "url"),
    room: {
      v: numberField(descriptor, "v") as RoomDescriptor["v"],
      roomId: stringField(descriptor, "roomId"),
      roomNonce: stringField(descriptor, "roomNonce"),
      desktopSigningKey: stringField(descriptor, "desktopSigningKey"),
      mobileSigningKey: stringField(descriptor, "mobileSigningKey"),
      notAfter: numberField(descriptor, "notAfter"),
    },
    mobilePrivateKeyJwk: {
      kty: "EC",
      crv: "P-256",
      d: key.d as string,
      x: key.x as string,
      y: key.y as string,
    },
  }
}
