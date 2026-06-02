// Endpoints, client_id, scopes, and headers for the Claude OAuth flow.
//
// Sources (see docs/content/docs/en/adr/0010-claude-subscription-oauth.md +
// docs/content/docs/en/adr/0025-unified-subscription-module.md):
//   - Pro/Max ↔ Console: same client_id, different authorize host + redirect
//     ([flopsstuff/coqu](https://flopsstuff.github.io/coqu/claude-oauth/),
//     [ben-vargas/claude-code-sdk_oauth gist](https://gist.github.com/ben-vargas/c7c7cbfebbb47278f45feca9cef309d1),
//     [robinebers/openusage](https://github.com/robinebers/openusage/blob/main/docs/providers/claude.md))
//   - Header set required for OAuth bearer:
//     [anthropics/claude-code#37205](https://github.com/anthropics/claude-code/issues/37205),
//     [NousResearch/hermes-agent#15080](https://github.com/NousResearch/hermes-agent/issues/15080)
//
// All values pinned here are public-knowledge constants extracted from the
// Claude Code CLI bundle / community OAuth implementations. Cognia-next is
// not an Anthropic-sanctioned third-party OAuth client; if the upstream flow
// changes, update this file + ADR-0025.

import type { AnthropicAuthMode } from "@/types/subscription"

/**
 * Public client_id used by the Claude Code CLI. The same UUID is sent for
 * both Pro/Max subscription and Console (API-billing) flows; the server
 * differentiates by authorize host + redirect URI.
 */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/** Form-encoded token endpoint (exchange + refresh both POST here). */
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export interface OAuthEndpointConfig {
  authorizeUrl: string
  redirectUri: string
  scopes: string
}

export const OAUTH_ENDPOINTS: Record<AnthropicAuthMode, OAuthEndpointConfig> = {
  subscription: {
    authorizeUrl: "https://claude.ai/oauth/authorize",
    redirectUri: "https://platform.claude.com/oauth/code/callback",
    scopes: "user:profile user:inference user:sessions:claude_code",
  },
  console: {
    authorizeUrl: "https://console.anthropic.com/oauth/authorize",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scopes: "org:create_api_key user:profile user:inference",
  },
}

export const OAUTH_REQUIRED_BETA_FEATURES = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "claude-code-20250219",
  "oauth-2025-04-20",
] as const

export const OAUTH_REQUEST_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": OAUTH_REQUIRED_BETA_FEATURES.join(","),
  "x-app": "cli",
} as const

/**
 * The Claude Code CLI's user-agent string. Pinned to the version captured in
 * [hermes-agent#15080](https://github.com/NousResearch/hermes-agent/issues/15080);
 * Anthropic does *not* validate the version, only the `claude-cli/...` shape.
 */
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.119 (external, cli)"
