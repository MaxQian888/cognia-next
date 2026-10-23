/**
 * The plugin contract's share of `lib/subscription/core/transport.ts`, which re-exports these.
 */

// ---------------------------------------------------------------------------
// OpenCode (discovery + paste-zen-key)
// ---------------------------------------------------------------------------

export interface DiscoveredOpencodeEntry {
  /**
   * Whitelist value: "anthropic" | "openai" | "opencode" | "opencode-go" |
   * "opencode-zen" (must stay in sync with `OPENCODE_WHITELIST`).
   */
  subProvider: string
  /** "api-key" | "oauth" | "unknown". */
  kind: string
  /** Verbatim JSON object for this sub-provider's entry. */
  payloadJson: string
}

export interface DiscoveredOpencodeAuth {
  /** Resolved path that was read (or would have been read). */
  authJsonPath: string
  /** Whitelisted sub-providers actually present in auth.json. */
  entries: DiscoveredOpencodeEntry[]
}
