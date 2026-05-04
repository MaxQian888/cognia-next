/**
 * Bearer token utilities for the External Bridge HTTP transport.
 *
 * Tokens are 32-byte random values, hex-encoded (64 chars). They live on
 * `AppSettings.externalBridge.bearerToken` as plaintext (IndexedDB is
 * already user-local; we revisit when the bridge supports remote network
 * access).
 *
 * Verification uses constant-time comparison so a timing oracle can't be
 * built from the HTTP error path. `hasToken` answers the cheaper "is the
 * server even configured" question without exposing the token bytes.
 */

const TOKEN_BYTES = 32

/**
 * Cross-runtime random byte source. Browser ships `crypto.getRandomValues`;
 * Node provides it via `node:crypto.webcrypto.getRandomValues`. Lazy import
 * keeps the cost off the cold path of every other call site.
 */
async function randomBytes(length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(out)
    return out
  }
  const { webcrypto } = await import("node:crypto")
  webcrypto.getRandomValues(out)
  return out
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Generate a fresh 64-char hex bearer token. */
export async function generateToken(): Promise<string> {
  const bytes = await randomBytes(TOKEN_BYTES)
  return toHex(bytes)
}

/**
 * Constant-time string compare. Returns false immediately on length
 * mismatch (the length itself is not secret).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Verify a candidate token against the stored token. Returns false when
 * either token is missing — the caller should map that to a 401, not a
 * "not configured" error, so probes can't distinguish the two.
 */
export function verifyToken(stored: string | undefined, candidate: string | undefined): boolean {
  if (!stored || !candidate) return false
  return constantTimeEquals(stored, candidate)
}

/** True when a token has been generated at least once. */
export function hasToken(stored: string | undefined): boolean {
  return Boolean(stored && stored.length > 0)
}

/** Extract a bearer token from an HTTP `Authorization` header value. */
export function parseBearerHeader(header: string | undefined | null): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+([A-Za-z0-9._\-]+)\s*$/.exec(header)
  return match ? match[1] : undefined
}

/** Test-only escape hatch so suites can validate the constants. */
export const __TESTING__ = { TOKEN_BYTES, randomBytes, toHex }
