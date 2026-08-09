/** Offline pairing payload. Its schema version is independent of public URLs. */
import { Buffer } from "buffer"

export interface PairPayload {
  baseUrl: string
  mode: "owner-invitation" | "oidc"
  invitation?: string
  hostId: string
  tenantId: string
  expiresAt: number
  serverVersion: string
  fingerprint: string
}

const PAYLOAD_VERSION = 3 as const
const HEADER = `cgnp${PAYLOAD_VERSION}|`

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
  return (
    HEADER +
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
  if (version !== PAYLOAD_VERSION) return { kind: "version_mismatch", got: version }
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
