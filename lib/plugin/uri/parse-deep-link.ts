// Parser for plugin deep-links: `cognia://plugin/<pluginId>/<path...>?<query>`
// (C2). Pure + side-effect-free so it can be unit-tested without a router.
// Mirrors the connector router's `new URL(raw.replace("cognia://", "https://…"))`
// trick to reuse the standard URL query parser.

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

const PLUGIN_HOST_RE = /^cognia:\/\/plugin\/([^/?#]+)(?:\/([^?#]*))?/

/**
 * Parse a `cognia://plugin/<id>/...` URL. Returns `null` for any URL that is
 * not a plugin deep-link (wrong scheme/host, missing plugin id).
 */
export function parseDeepLink(raw: string): ParsedDeepLink | null {
  const match = PLUGIN_HOST_RE.exec(raw)
  if (!match) return null
  const pluginId = decodeURIComponent(match[1])
  if (!pluginId) return null
  const path = match[2] ? match[2].replace(/\/+$/, "") : ""

  let query: Record<string, string> = {}
  try {
    const url = new URL(raw.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
    query = Object.fromEntries(url.searchParams.entries())
  } catch {
    query = {}
  }

  return { pluginId, path, query, raw }
}
