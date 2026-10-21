// Parser for plugin deep-links: `cognia://plugin/<pluginId>/<path...>?<query>`
// (C2). Pure + side-effect-free so it can be unit-tested without a router.
// Mirrors the connector router's `new URL(raw.replace("cognia://", "https://…"))`
// trick to reuse the standard URL query parser.

import type { ParsedDeepLink } from "@cognia/plugin-contract/lib/plugin/uri/parse-deep-link"
export type { ParsedDeepLink } from "@cognia/plugin-contract/lib/plugin/uri/parse-deep-link"

const PLUGIN_HOST_RE = /^cognia:\/\/plugin\/([^/?#]+)(?:\/([^?#]*))?/

/**
 * Parse a `cognia://plugin/<id>/...` URL. Returns `null` for any URL that is
 * not a plugin deep-link (wrong scheme/host, missing plugin id).
 *
 * `web+cognia://` — the scheme the manifest's `protocol_handlers` registers,
 * since `cognia://` is not an allowed `web+*` target — is normalized to
 * `cognia://` before matching. `raw` in the result keeps the original.
 */
export function parseDeepLink(raw: string): ParsedDeepLink | null {
  const link = raw.startsWith("web+cognia://") ? raw.slice(4) : raw
  const match = PLUGIN_HOST_RE.exec(link)
  if (!match) return null
  const pluginId = decodeURIComponent(match[1])
  if (!pluginId) return null
  const path = match[2] ? match[2].replace(/\/+$/, "") : ""

  let query: Record<string, string> = {}
  try {
    const url = new URL(link.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
    query = Object.fromEntries(url.searchParams.entries())
  } catch {
    query = {}
  }

  return { pluginId, path, query, raw }
}
