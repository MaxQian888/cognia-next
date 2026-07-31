/**
 * An `OAuthClientProvider` (the SDK's client-side OAuth contract) backed by the
 * `mcp-auth.json` store. The SDK's `StreamableHTTPClientTransport` /
 * `SSEClientTransport` drive this during `connect()`:
 *
 *   - reads stored `tokens()` to attach the access token (and refresh it);
 *   - on a fresh authorization, `saveCodeVerifier` → `redirectToAuthorization`
 *     (we open the browser) → after `finishAuth(code)` the SDK calls
 *     `saveTokens` with the exchanged tokens.
 *
 * Dynamic client registration is supported via `saveClientInformation` /
 * `clientInformation`, so servers that require it (most remote MCP servers) work
 * without the user pre-registering an OAuth client.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"

import { patchAuthEntry, readAuthEntry, type McpAuthFs } from "./oauth-store"

export interface OAuthProviderDeps {
  home: string
  serverName: string
  /** Loopback redirect URI the local callback server listens on. */
  redirectUrl: string
  /** Human-facing client name sent during dynamic registration. */
  clientName?: string
  /** Requested OAuth scope (space-delimited), if the server needs one. */
  scope?: string
  /** CSRF state value; the callback verifies the server echoes it back. */
  state?: string
  /** Invoked with the authorization URL — the flow opens the browser here. */
  onRedirect: (url: URL) => void | Promise<void>
  fs?: McpAuthFs
}

/** Build an SDK-compatible OAuth client provider over the on-disk auth store. */
export function createMcpOAuthProvider(deps: OAuthProviderDeps): OAuthClientProvider {
  const entry = () => readAuthEntry(deps.home, deps.serverName, deps.fs)

  const metadata: OAuthClientMetadata = {
    client_name: deps.clientName ?? "Cognia CLI",
    redirect_uris: [deps.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client + PKCE: no client secret to store on the user's machine.
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
      return entry().clientInformation as OAuthClientInformationMixed | undefined
    },
    saveClientInformation(info) {
      patchAuthEntry(
        deps.home,
        deps.serverName,
        { clientInformation: info as Record<string, unknown> },
        deps.fs
      )
    },
    tokens() {
      return entry().tokens as OAuthTokens | undefined
    },
    saveTokens(tokens) {
      // Tokens supersede the in-flight verifier; drop it so a stale value can't
      // be reused on a later (unrelated) exchange.
      patchAuthEntry(
        deps.home,
        deps.serverName,
        { tokens: tokens as Record<string, unknown>, codeVerifier: undefined },
        deps.fs
      )
    },
    redirectToAuthorization(authorizationUrl) {
      return deps.onRedirect(authorizationUrl)
    },
    saveCodeVerifier(verifier) {
      patchAuthEntry(deps.home, deps.serverName, { codeVerifier: verifier }, deps.fs)
    },
    codeVerifier() {
      const v = entry().codeVerifier
      if (!v) throw new Error("No PKCE code verifier saved for this MCP server")
      return v
    },
  }
}
