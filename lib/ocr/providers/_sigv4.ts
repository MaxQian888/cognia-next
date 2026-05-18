/**
 * Minimal AWS Signature V4 signer.
 *
 * Implements the request-signing algorithm documented at
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html
 * for the POST + JSON request shapes the AWS Textract provider uses.
 *
 * Runs against `crypto.subtle` so it works in browser, Tauri webview,
 * Capacitor webview, and Jest (`jest.setup.ts` polyfills webcrypto).
 */

const ALGORITHM = "AWS4-HMAC-SHA256"

export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** Optional session token for STS / SSO credentials. */
  sessionToken?: string
}

export interface SigV4Request {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  /** Service identifier — e.g. "textract", "s3". */
  service: string
  region: string
  /** Full URL including scheme + host + path. Query string optional. */
  url: string
  headers: Record<string, string>
  body: string | Uint8Array
  /** Override for the request timestamp (used in tests). */
  now?: Date
}

export interface SignedRequest {
  headers: Record<string, string>
  url: string
}

export async function signRequest(
  credentials: SigV4Credentials,
  request: SigV4Request
): Promise<SignedRequest> {
  const now = request.now ?? new Date()
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${request.region}/${request.service}/aws4_request`

  const parsedUrl = new URL(request.url)
  const canonicalUri = parsedUrl.pathname || "/"
  const canonicalQueryString = canonicalizeQuery(parsedUrl.searchParams)

  const payloadBytes =
    typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body
  const payloadHash = await sha256Hex(payloadBytes)

  const headers: Record<string, string> = { ...request.headers }
  headers["host"] = parsedUrl.host
  headers["x-amz-date"] = amzDate
  headers["x-amz-content-sha256"] = payloadHash
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken
  }

  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers)

  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const signingKey = await deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    request.region,
    request.service
  )
  const signature = await hmacHex(signingKey, stringToSign)

  headers["authorization"] = [
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ")

  return { headers, url: request.url }
}

function canonicalizeQuery(params: URLSearchParams): string {
  const entries: [string, string][] = []
  params.forEach((v, k) => entries.push([k, v]))
  return entries
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
}

function canonicalizeHeaders(headers: Record<string, string>): {
  canonicalHeaders: string
  signedHeaders: string
} {
  const lowered = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalHeaders = lowered.map(([k, v]) => `${k}:${v}`).join("\n") + "\n"
  const signedHeaders = lowered.map(([k]) => k).join(";")
  return { canonicalHeaders, signedHeaders }
}

function formatAmzDate(date: Date): string {
  const iso = date.toISOString().replace(/[-:]/g, "")
  // ISO -> 20060102T150405.000Z; we want 20060102T150405Z.
  return iso.replace(/\.\d{3}Z$/, "Z")
}

const RFC3986_UNRESERVED = /[A-Za-z0-9\-._~]/

function encodeRfc3986(s: string): string {
  let out = ""
  for (const ch of s) {
    if (RFC3986_UNRESERVED.test(ch)) {
      out += ch
    } else {
      const bytes = new TextEncoder().encode(ch)
      for (const b of bytes) {
        out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`
      }
    }
  }
  return out
}

const HEX = "0123456789abcdef"

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf)
  let out = ""
  for (let i = 0; i < view.length; i++) {
    const b = view[i]!
    out += HEX[b >>> 4]! + HEX[b & 0x0f]!
  }
  return out
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("sigv4: Web Crypto unavailable")
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  const digest = await subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)
  return bytesToHex(digest)
}

async function hmacRaw(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("sigv4: Web Crypto unavailable")
  const keyBuf =
    key instanceof Uint8Array
      ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
      : key
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const sig = await hmacRaw(key, message)
  return bytesToHex(sig)
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const initial = new TextEncoder().encode(`AWS4${secret}`)
  const kDate = await hmacRaw(initial, dateStamp)
  const kRegion = await hmacRaw(kDate, region)
  const kService = await hmacRaw(kRegion, service)
  return hmacRaw(kService, "aws4_request")
}
