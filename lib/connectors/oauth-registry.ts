/**
 * OAuth handler registry — Task 42.
 *
 * Maps platform kind to the async function that completes the OAuth code
 * exchange and stores the resulting credentials in the keyring.
 *
 * Phase 1: Telegram doesn't use OAuth — the registry is empty. Future phases
 * (CP-E Slack, CP-F Lark) will populate it via:
 *
 *   oauthRegistry.set("slack", async (code) => { … })
 *
 * The ConnectorDeepLinkRouter calls the registered handler after validating
 * the OAuth state parameter.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"

export type OAuthHandler = (code: string) => Promise<void>

/**
 * Global registry: PlatformKind → OAuth completion handler.
 * Empty for Phase 1 — Telegram does not use OAuth.
 */
export const oauthRegistry = new Map<PlatformKind, OAuthHandler>()
