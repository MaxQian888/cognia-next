/**
 * Slack OAuth 2.0 URL builder — Task 75.
 *
 * Builds the https://slack.com/oauth/v2/authorize URL with all required
 * parameters for the OAuth v2 flow (bot token + optional user token scopes).
 */

export interface SlackOAuthUrlInput {
  clientId: string
  scopes: string[]
  redirectUri: string
  state: string
  userScopes?: string[]
}

/**
 * Build the Slack OAuth v2 authorization URL.
 *
 * URL-encodes all parameters. `state` and `redirectUri` come from
 * `oauth-begin.ts`, which mints the `slack:<adapterId>:<nonce>` state and
 * persists the pending record before this URL is handed out — the durable
 * record, not any browser storage, is what `handleSlackOAuth` validates
 * against. `redirectUri` must be https: Slack's console will not register a
 * custom scheme.
 */
export function buildSlackOAuthUrl(input: SlackOAuthUrlInput): string {
  const params = new URLSearchParams()
  params.set("client_id", input.clientId)
  params.set("scope", input.scopes.join(","))
  params.set("redirect_uri", input.redirectUri)
  params.set("state", input.state)

  if (input.userScopes && input.userScopes.length > 0) {
    params.set("user_scope", input.userScopes.join(","))
  }

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`
}
