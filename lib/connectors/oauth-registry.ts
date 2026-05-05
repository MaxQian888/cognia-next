/**
 * OAuth handler registry — Task 42 + Task 80.
 *
 * Maps platform kind to the async function that completes the OAuth code
 * exchange and stores the resulting credentials in the keyring.
 *
 * Phase 1: Telegram and Discord do not use OAuth. Slack registers a stub
 * handler that throws — routing is wired so cognia://connector/oauth/slack
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
