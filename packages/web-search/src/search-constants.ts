/**
 * Search constants
 */

import type { CustomSearchSource, LegacyCustomSearchSource, SearchProviderType } from "./types"

/**
 * Search source definition
 */
interface SearchSourceBase {
  id: string
  name: string
  icon: string
}

export interface ProviderSearchSource extends SearchSourceBase {
  kind: "provider"
  provider: SearchProviderType
}

export interface DomainSearchSource extends SearchSourceBase {
  kind: "domain"
  domain: string
}

export type SearchSource = ProviderSearchSource | DomainSearchSource

/**
 * Available search sources for research
 */
export const SEARCH_SOURCES: SearchSource[] = [
  { id: "google", name: "Google", icon: "🔍", kind: "provider", provider: "google" },
  { id: "brave", name: "Brave", icon: "🦁", kind: "provider", provider: "brave" },
  { id: "bing", name: "Bing", icon: "🔎", kind: "provider", provider: "bing" },
  {
    id: "wikipedia",
    name: "Wikipedia",
    icon: "📚",
    kind: "domain",
    domain: "wikipedia.org",
  },
  { id: "arxiv", name: "arXiv", icon: "📄", kind: "domain", domain: "arxiv.org" },
  { id: "github", name: "GitHub", icon: "💻", kind: "domain", domain: "github.com" },
  {
    id: "stackoverflow",
    name: "Stack Overflow",
    icon: "💬",
    kind: "domain",
    domain: "stackoverflow.com",
  },
]

/**
 * The package's single host normalizer: lower-cases, strips a leading `www.`
 * and a trailing dot, refuses non-http(s) schemes, embedded credentials and
 * anything that is not a well-formed public domain.
 *
 * Shared by the custom-source form, the blocked-domain policy and the
 * include-domain filter. They each had their own looser copy, so the same
 * input (`ftp://…`, a credentialed URL, a trailing-dot host) normalized three
 * different ways depending on which filter saw it.
 */
export function normalizeSearchDomain(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null
    }
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "")
    const validDomain =
      /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i
    return validDomain.test(hostname) ? hostname : null
  } catch {
    return null
  }
}

/**
 * Normalize either the current custom-source shape or a legacy row. Legacy
 * rows are upgraded only when their name itself is a valid domain/URL; callers
 * can retain a null result as disabled until the user supplies a domain.
 */
export function normalizeCustomSearchSource(
  source: CustomSearchSource | LegacyCustomSearchSource
): CustomSearchSource | null {
  const domain = normalizeSearchDomain(source.domain ?? source.name)
  if (!domain) return null
  return {
    id: source.id,
    name: source.name,
    ...(source.icon ? { icon: source.icon } : {}),
    domain,
  }
}
