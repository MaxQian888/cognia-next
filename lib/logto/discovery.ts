/**
 * OIDC discovery for a Logto tenant (ADR-0059 cloud/headless — Logto).
 *
 * Resolves the authorization + token endpoints from the issuer's
 * `/.well-known/openid-configuration` document — the same document the Rust
 * gateway's JWKS cache reads (`src-tauri/src/companion_api/oidc.rs`). Keeping
 * the client and resource server on OIDC discovery means neither hard-codes
 * Logto's URL layout.
 */

/** The endpoints the PKCE login flow needs, resolved from discovery. */
export interface LogtoEndpoints {
  /** The `iss` claim value tokens will carry. */
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri?: string
  endSessionEndpoint?: string
}

/**
 * Fetch `<issuer>/.well-known/openid-configuration` and extract the endpoints.
 *
 * @param issuer The Logto OIDC issuer, e.g. `https://logto.example.com/oidc`.
 * @param fetchImpl Injectable fetch (defaults to the global).
 */
export async function discoverLogtoEndpoints(
  issuer: string,
  fetchImpl: typeof fetch = fetch
): Promise<LogtoEndpoints> {
  const base = issuer.replace(/\/+$/, "")
  const url = `${base}/.well-known/openid-configuration`
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } })
  if (!res.ok) {
    throw new Error(`Logto OIDC discovery failed: ${res.status} ${res.statusText}`)
  }
  const doc = (await res.json()) as Record<string, unknown>
  const authorizationEndpoint = doc.authorization_endpoint
  const tokenEndpoint = doc.token_endpoint
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new Error("Logto discovery document is missing authorization_endpoint or token_endpoint")
  }
  return {
    issuer: typeof doc.issuer === "string" ? doc.issuer : base,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri: typeof doc.jwks_uri === "string" ? doc.jwks_uri : undefined,
    endSessionEndpoint:
      typeof doc.end_session_endpoint === "string" ? doc.end_session_endpoint : undefined,
  }
}
