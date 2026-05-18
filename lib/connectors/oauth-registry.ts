/**
 * OAuth handler registry — Task 42 + Task 80 + Task 93, extended at
 * ADR-0009 v41 / A4 (D2) to land Lark's code-exchange completion.
 *
 * Maps platform kind to the async function that completes the OAuth code
 * exchange and stores the resulting credentials in the keyring.
 *
 * Telegram and Discord do not use OAuth. Slack still ships the stub
 * (D1 carryover). Lark now runs the full
 * `handleLarkOAuth(code, {state})` path which resolves the adapter row,
 * decrypts the app secret, swaps the code for user_access_token +
 * refresh_token, and stamps the connected-user metadata.
 *
 * The ConnectorDeepLinkRouter calls the registered handler after
 * validating the OAuth state parameter — state is also forwarded into
 * the handler so platform handlers can decode `adapterId` from a
 * platform-specific state shape (Lark uses `lark:<adapterId>:<nonce>`).
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"

export type OAuthHandler = (code: string, state: string) => Promise<void>

/**
 * Global registry: PlatformKind → OAuth completion handler.
 */
export const oauthRegistry = new Map<PlatformKind, OAuthHandler>()

// ---------------------------------------------------------------------------
// Slack — Phase 1 stub
// Routes cognia://connector/oauth/slack?code=... to a known handler.
// Full token exchange is implemented in Phase 2 (D1).
// ---------------------------------------------------------------------------

oauthRegistry.set("slack", async (_code: string, _state: string): Promise<void> => {
  throw new Error("Slack OAuth exchange not yet implemented (Phase 2)")
})

// ---------------------------------------------------------------------------
// Lark — fully wired at ADR-0009 v41 / A4 (D2).
// Routes cognia://connector/oauth/lark?code=...&state=lark:<adapterId>:<nonce>
// through `handleLarkOAuth`. The handler:
//   1. Parses `adapterId` out of state.
//   2. Loads the adapter row + decrypts the app secret from keyring.
//   3. Acquires a tenant-access-token.
//   4. Calls /open-apis/authen/v1/oidc/access_token to swap the code for
//      a user_access_token + refresh_token.
//   5. Persists tokens in keyring under `<adapterId>:user_token` +
//      `<adapterId>:user_refresh_token`.
//   6. Stamps `connectedUser` metadata onto the adapter row.
// ---------------------------------------------------------------------------

oauthRegistry.set("lark", async (code: string, state: string): Promise<void> => {
  const { handleLarkOAuth } = await import("./adapters/lark/oauth-handler")
  await handleLarkOAuth(code, { state })
})
