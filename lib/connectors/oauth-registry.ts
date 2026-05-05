/**
 * OAuth handler registry — Task 42 + Task 80 + Task 93.
 *
 * Maps platform kind to the async function that completes the OAuth code
 * exchange and stores the resulting credentials in the keyring.
 *
 * Phase 1: Telegram and Discord do not use OAuth. Slack and Lark register stub
 * handlers that throw — routing is wired so cognia://connector/oauth/<platform>
 * resolves to a known handler. Full exchange lands in Phase 2.
 *
 * The ConnectorDeepLinkRouter calls the registered handler after validating
 * the OAuth state parameter.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"

export type OAuthHandler = (code: string) => Promise<void>

/**
 * Global registry: PlatformKind → OAuth completion handler.
 */
export const oauthRegistry = new Map<PlatformKind, OAuthHandler>()

// ---------------------------------------------------------------------------
// Slack — Phase 1 stub
// Routes cognia://connector/oauth/slack?code=... to a known handler.
// Full token exchange is implemented in Phase 2.
// ---------------------------------------------------------------------------

oauthRegistry.set("slack", async (_code: string): Promise<void> => {
  throw new Error("Slack OAuth exchange not yet implemented (Phase 2)")
})

// ---------------------------------------------------------------------------
// Lark — Phase 1 stub
// Routes cognia://connector/oauth/lark?code=... to a known handler.
// Full token exchange (code → app_access_token → user_access_token) is
// implemented in Phase 2. Lark's OAuth flow follows RFC 6749 authorization
// code grant using /open-apis/authen/v1/oidc/access_token.
// ---------------------------------------------------------------------------

oauthRegistry.set("lark", async (_code: string): Promise<void> => {
  throw new Error("Lark OAuth exchange not yet implemented (Phase 2)")
})
