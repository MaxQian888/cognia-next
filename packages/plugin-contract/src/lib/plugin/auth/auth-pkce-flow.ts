/**
 * The plugin contract's share of `lib/plugin/auth/auth-pkce-flow.ts`, which re-exports these.
 */
export interface PkceFlowConfig {
  /** Authorization endpoint (no query string). */
  authorizeUrl: string
  /** Token endpoint for the code→token exchange. */
  tokenUrl: string
  clientId: string
  scopes: string[]
  redirectUri: string
  /** Open the authorize URL (window.open / shell open / CLI browser). */
  openUrl: (url: string) => void | Promise<void>
  /**
   * Await the redirect and return the `code`+`state`. Implementations bind a
   * loopback server (desktop/CLI) or listen on a BroadcastChannel (web).
   * `codeVerifier` is this request's PKCE verifier, for a driver that can
   * recover a code the redirect never delivered by proving it holds the
   * verifier (the phone's app-return claim, `lib/logto/capacitor-drivers.ts`).
   */
  waitForCode: (params: { redirectUri: string; state: string; codeVerifier: string }) => Promise<{
    code: string
    state: string
  }>
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch
  /** Extra authorize-URL params (e.g. `access_type=offline`). */
  extraAuthParams?: Record<string, string>
  /**
   * Extra token-exchange body params (e.g. Logto's RFC-8707 `resource`
   * indicator and `organization_id`). Merged into the `POST` body so the
   * authorization server can bind the issued access token to an API resource
   * / organization.
   */
  extraTokenParams?: Record<string, string>
  /** Random state. Injectable for tests; defaults to a PKCE verifier. */
  state?: string
}

export interface PkceTokenResult {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  raw: Record<string, unknown>
}
