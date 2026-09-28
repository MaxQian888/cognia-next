import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { AuthState, ProviderDeps } from "./types.ts"

/** 16 hex chars of CSRF state (the redirect is loopback). (Pure — tested.) */
export function randomState() {
  let s = ""
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/**
 * Build an in-memory `OAuthClientProvider` over a mutable `state` object
 * (seeded from the stored entry). Mirrors `cli/src/mcp/oauth-provider.ts` but
 * keeps everything in memory — Rust persists the final `state` to the keyring.
 * (Pure given its deps — the provider object is unit-tested.)
 */
export function buildProvider(state: AuthState, deps: ProviderDeps) {
  const metadata: OAuthClientProvider["clientMetadata"] = {
    client_name: deps.clientName ?? "Cognia",
    redirect_uris: [deps.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(deps.scope ? { scope: deps.scope } : {}),
  }
  return {
    get redirectUrl() {
      return deps.redirectUrl
    },
    get clientMetadata() {
      return metadata
    },
    state() {
      return deps.state ?? ""
    },
    clientInformation() {
      return state.clientInformation
    },
    saveClientInformation(info: OAuthClientInformationMixed) {
      state.clientInformation = info
    },
    tokens() {
      return state.tokens
    },
    saveTokens(tokens: OAuthTokens) {
      state.tokens = tokens
      state.codeVerifier = undefined
      // Stamp absolute expiry so the renderer can show / proactively act on it.
      if (tokens && typeof tokens.expires_in === "number") {
        state.expiresAtMs = Date.now() + tokens.expires_in * 1000
      }
    },
    redirectToAuthorization(url: URL) {
      return deps.onRedirect!(url)
    },
    saveCodeVerifier(verifier: string) {
      state.codeVerifier = verifier
    },
    codeVerifier() {
      if (!state.codeVerifier) throw new Error("No PKCE code verifier saved")
      return state.codeVerifier
    },
  }
}
