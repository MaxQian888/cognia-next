/**
 * PKCE (RFC 7636) helpers for the Lark OAuth 2.0 authorization-code flow.
 *
 * Feishu's authorize endpoint accepts `code_challenge` + `code_challenge_method`,
 * and the v2 token endpoint accepts the matching `code_verifier`. Binding the
 * two hardens the relay redirect (the `code` briefly rides a public tunnel URL)
 * against interception: without the verifier the intercepted code can't be
 * exchanged.
 *
 * We only implement the S256 method — `plain` is the RFC default but offers no
 * protection, so it is intentionally unsupported.
 */

/** The only challenge method we emit. */
export const CODE_CHALLENGE_METHOD = "S256"

/** Base64url-encode raw bytes (no padding), per RFC 7636 §A. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Generate a cryptographically-random `code_verifier`. 32 random bytes
 * base64url-encode to 43 chars — within the RFC's 43–128 range and drawn
 * entirely from the unreserved set `[A-Za-z0-9-._~]`.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/**
 * Derive the `code_challenge` for a verifier: base64url(SHA-256(verifier)).
 * Async because it uses the Web Crypto `subtle.digest` API.
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return base64UrlEncode(new Uint8Array(digest))
}
