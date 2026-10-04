/**
 * RFC 7009 §2.2 for `/oauth2/revoke`: "invalid tokens do not cause an error
 * response", because a token the issuer no longer knows is already revoked.
 *
 * Better Auth answers such a token with `400 invalid_request` and
 * `token not found` (a token it never issued) or `refresh token revoked` (one
 * a rotation or an earlier sign-out already retired), so a client that
 * revokes on sign-out would report a failure after every successful one. A
 * JWT access token is different: it is answered with RFC 7009 §2.2.1's own
 * `unsupported_token_type`, which is correct and passes through. This turns exactly that
 * answer into the `200` the RFC specifies; every other error (a bad client,
 * a malformed request) passes through unchanged.
 */

export const REVOKE_PATH = "/api/auth/oauth2/revoke"

/** Better Auth's descriptions of a token that is already gone. */
const ALREADY_REVOKED = new Set(["token not found", "refresh token revoked"])

export async function normalizeRevocation(response: Response): Promise<Response> {
  if (response.status !== 400) return response
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown; error_description?: unknown } | null
  if (
    body?.error !== "invalid_request" ||
    typeof body.error_description !== "string" ||
    !ALREADY_REVOKED.has(body.error_description)
  ) {
    return response
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } })
}
