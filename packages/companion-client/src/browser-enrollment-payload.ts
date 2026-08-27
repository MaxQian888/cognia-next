/**
 * The offline payload a user copies from Cognia's settings into the browser
 * side panel.
 *
 * Its own header (`cgnb1|`) rather than a mode on `cgnp3|`, because the two
 * codes are not interchangeable in either direction. A pairing invitation
 * advertises `https://…:27890`, which a tab cannot reach at all — the Host's
 * certificate is self-signed with no CA, and a browser validates against
 * system roots with no JS escape hatch. A browser enrollment advertises the
 * plaintext loopback listener, which is exempt from mixed-content blocking
 * because `http://127.0.0.1` is "potentially trustworthy" per Secure Contexts.
 * Sharing one header would let each code be pasted where it silently cannot
 * work, and the failure would surface as a connection error rather than as
 * "this is the wrong code".
 *
 * The payload carries no bearer credential. `enrollment` is a one-time token
 * that only becomes an identity when it is spent against
 * `POST /api/auth/browser/register` together with a device key the Host has
 * never seen, and the Host consumes it in the same transaction that writes the
 * device — so a copied code is spent, not shared.
 */
import { base64UrlToText, textToBase64Url } from "./base64url"

export interface BrowserEnrollmentPayload {
  /** Always the plaintext loopback listener, e.g. `http://127.0.0.1:27891`. */
  baseUrl: string
  tenantId: string
  enrollment: string
  /** Epoch milliseconds. */
  expiresAt: number
}

const PAYLOAD_VERSION = 1 as const
const HEADER = `cgnb${PAYLOAD_VERSION}|`

export function encodeBrowserEnrollmentPayload(payload: BrowserEnrollmentPayload): string {
  return (
    HEADER +
    textToBase64Url(
      JSON.stringify({
        base: payload.baseUrl,
        tenant: payload.tenantId,
        enrollment: payload.enrollment,
        exp: payload.expiresAt,
      })
    )
  )
}

/**
 * The result of reading a pasted code.
 *
 * Same four-way vocabulary as `decodePairPayload`, and for the same reason:
 * "this is not one of our codes", "this is one of ours but from a newer
 * Cognia", and "this is ours and it is broken or stale" are three different
 * things to tell somebody, and a thrown error collapses them into one.
 */
export type BrowserEnrollmentDecodeOutcome =
  | { kind: "ok"; payload: BrowserEnrollmentPayload }
  | { kind: "wrong_format" }
  | { kind: "version_mismatch"; got: number }
  | { kind: "invalid"; message: string }

export function decodeBrowserEnrollmentPayload(
  raw: string,
  now: number = Date.now()
): BrowserEnrollmentDecodeOutcome {
  const match = /^cgnb(\d+)\|(.+)$/.exec(raw.trim())
  if (!match) return { kind: "wrong_format" }
  const version = Number.parseInt(match[1], 10)
  if (version !== PAYLOAD_VERSION) return { kind: "version_mismatch", got: version }
  try {
    const value = JSON.parse(base64UrlToText(match[2])) as Record<string, unknown>
    const payload: BrowserEnrollmentPayload = {
      baseUrl: stringField(value, "base"),
      tenantId: stringField(value, "tenant"),
      enrollment: stringField(value, "enrollment"),
      expiresAt: numberField(value, "exp"),
    }
    // Refuse anything that is not the plaintext loopback plane. A code aimed
    // anywhere else is either a mistake or an attempt to point the extension
    // at somebody else's host, and the extension holds only a loopback host
    // permission anyway — accepting it would produce a permission prompt the
    // user cannot satisfy instead of a legible refusal.
    if (!isLoopbackHttpOrigin(payload.baseUrl)) {
      return { kind: "invalid", message: "the code does not name this machine's browser listener" }
    }
    if (payload.expiresAt <= now) {
      return { kind: "invalid", message: "the pairing code has expired" }
    }
    return { kind: "ok", payload }
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * `http://` on a loopback host, with nothing after the origin.
 *
 * Mirrors the Rust `is_secure_or_loopback` loopback arm. `https` is
 * deliberately not accepted here even though it is "more secure": the browser
 * plane is plaintext by construction, and a code claiming otherwise names a
 * listener that does not exist.
 */
function isLoopbackHttpOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false
  if (url.username !== "" || url.password !== "") return false
  const host = url.hostname
  if (host === "localhost" || host === "[::1]") return true
  // 127.0.0.0/8 — the whole loopback block, matching `Ipv4Addr::is_loopback`.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10))
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
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
