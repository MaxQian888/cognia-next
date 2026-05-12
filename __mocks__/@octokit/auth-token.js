/**
 * Manual Jest mock for `@octokit/auth-token` (PAT auth strategy).
 *
 * `createTokenAuth(token)` returns an async callable that resolves to a
 * `{ type: "token", token, tokenType: "oauth" }` credential. We mirror that
 * surface so the Octokit mock can hand a working `auth()` to consumers.
 */

function createTokenAuth(input) {
  // Per the real package, input may be a bare token string or an object.
  const token = typeof input === "string" ? input : input?.token
  return async () => ({ type: "token", token, tokenType: "oauth" })
}

module.exports = { createTokenAuth }
