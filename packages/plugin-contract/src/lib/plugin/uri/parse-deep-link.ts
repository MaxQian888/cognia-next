/**
 * The plugin contract's share of `lib/plugin/uri/parse-deep-link.ts`, which re-exports these.
 */
export interface ParsedDeepLink {
  /** Target plugin id (the first path segment after `plugin/`). */
  pluginId: string
  /** Remaining path after the plugin id (no leading slash), e.g. `auth/callback`. */
  path: string
  /** Decoded query parameters. */
  query: Record<string, string>
  /** The original raw URL. */
  raw: string
}
