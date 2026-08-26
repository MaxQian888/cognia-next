/**
 * How a recognised link READS in the composer — the icon it gets and the short
 * label that stands in for a 90-character URL.
 *
 * Recognition (what counts as a link) lives in `link-token.ts`; dereferencing
 * lives in `link-context.ts`. This module only decides presentation, so it is
 * pure and safe to call on every keystroke.
 *
 * ## Why rules at all
 *
 * `https://github.com/svenstaro/genact` is a repository, and the half of it the
 * reader needs is `svenstaro/genact`. A bare hostname (`github.com`) is the
 * opposite mistake — it tells you the site and nothing about the page. The
 * built-in table below shortens the handful of hosts where the useful part is
 * predictable, and everything else falls back to "the URL without its scheme",
 * middle-elided when it is long.
 *
 * ## Why user rules
 *
 * Every team has an internal host whose URLs are mostly boilerplate prefix
 * (`https://wiki.corp.example/display/ENG/`). One line of settings —
 * host + the prefix to drop — turns those into readable labels without a code
 * change. User rules are consulted BEFORE the built-ins so a team can also
 * override one.
 */

/** One presentation rule. `host` is matched as a hostname suffix. */
export interface LinkDisplayRule {
  /** Hostname or parent domain, e.g. `github.com` or `corp.example`. */
  host: string
  /**
   * Literal prefix removed from the URL to form the label. When absent, the
   * rule only contributes its `compact` shape (built-ins) or nothing at all.
   */
  strip?: string
  /** A named built-in shortener. Only the table below sets this. */
  compact?: "repo"
}

/** How much of a URL a chip should show. */
export type LinkDisplayStyle = "short" | "host" | "full"

export interface LinkDisplaySettings {
  style?: LinkDisplayStyle
  /** Consulted before the built-in table; first host-suffix match wins. */
  rules?: readonly LinkDisplayRule[]
}

export interface LinkDisplay {
  /** The absolute URL, unchanged — what the chip links to. */
  href: string
  /** Hostname with any `www.` dropped. */
  host: string
  /** Short label for the chip face. */
  label: string
  /**
   * Candidate brand-icon id derived from the host (`github.com` → `github`).
   * The renderer decides whether an asset exists for it (`hasBrandIcon`) and
   * falls back to a generic link glyph when it does not — keeping this module
   * free of any component import.
   */
  brandId: string
  /** Full URL for the tooltip / title attribute. */
  title: string
}

/**
 * Hosts whose useful part is predictable. Deliberately short: a rule earns its
 * place only when the generic fallback reads badly for that host.
 */
const BUILTIN_RULES: readonly LinkDisplayRule[] = [
  { host: "github.com", compact: "repo" },
  { host: "gitlab.com", compact: "repo" },
  { host: "bitbucket.org", compact: "repo" },
]

/** Label longer than this gets its middle elided. */
const MAX_LABEL = 44

function stripWww(host: string): string {
  return host.replace(/^www\./i, "")
}

/** True when `host` is `rule.host` or a subdomain of it. */
function hostMatches(host: string, ruleHost: string): boolean {
  const target = stripWww(ruleHost.trim().toLowerCase())
  if (!target) return false
  return host === target || host.endsWith(`.${target}`)
}

/**
 * The brand-icon id a host suggests: the label before the public suffix, which
 * is what the icon set is keyed on (`docs.google.com` → `google`).
 */
export function brandIdForHost(host: string): string {
  const labels = stripWww(host).split(".").filter(Boolean)
  if (labels.length <= 1) return labels[0] ?? ""
  // Two-part public suffixes (`.co.uk`, `.com.cn`) would otherwise yield the
  // suffix itself. Checking for a 2-letter country label after a 2-3 letter
  // generic one covers them without shipping a suffix list.
  const last = labels[labels.length - 1]
  const secondLast = labels[labels.length - 2]
  if (last.length === 2 && secondLast.length <= 3 && labels.length >= 3) {
    return labels[labels.length - 3]
  }
  return secondLast
}

/** `owner/repo`, plus `#123` for an issue or pull-request page. */
function repoLabel(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const base = `${parts[0]}/${parts[1]}`
  const number = parts.length >= 4 && /^\d+$/.test(parts[3]) ? parts[3] : null
  const isTicket = parts[2] === "issues" || parts[2] === "pull" || parts[2] === "merge_requests"
  return number && isTicket ? `${base}#${number}` : base
}

/** Everything after the scheme, with `www.` and a trailing slash removed. */
function schemelessLabel(url: URL): string {
  const rest = `${stripWww(url.host)}${url.pathname}${url.search}${url.hash}`
  return rest.length > 1 && rest.endsWith("/") ? rest.slice(0, -1) : rest
}

/**
 * Middle-elide a long label at a path boundary so both the host and the last,
 * most specific segment survive. Falls back to a tail ellipsis when there is no
 * boundary to cut on.
 */
export function elideLabel(label: string, max = MAX_LABEL): string {
  if (label.length <= max) return label
  const parts = label.split("/")
  if (parts.length > 2) {
    const candidate = `${parts[0]}/…/${parts[parts.length - 1]}`
    if (candidate.length < label.length) {
      return candidate.length <= max ? candidate : `${candidate.slice(0, max - 1)}…`
    }
  }
  return `${label.slice(0, max - 1)}…`
}

/**
 * Describe `url` for a composer chip. Never throws: an unparseable string comes
 * back as its own label, which is what the user typed anyway.
 */
export function describeLink(url: string, settings?: LinkDisplaySettings): LinkDisplay {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { href: url, host: url, label: elideLabel(url), brandId: "", title: url }
  }
  const host = stripWww(parsed.hostname)
  const base = { href: url, host, brandId: brandIdForHost(host), title: url }
  const style = settings?.style ?? "short"
  if (style === "host") return { ...base, label: host }
  if (style === "full") return { ...base, label: url }

  // Every matching rule gets a turn, user rules first, and a rule that produces
  // NOTHING falls through to the next one instead of ending the search.
  //
  // Stopping at the first host match let a rule with no `strip` — which is what
  // `parseLinkRules` builds for a line that is just `github.com` — silently
  // disable the built-in repo shortener for that host, and did the same to any
  // rule whose prefix did not happen to match the URL in hand. A rule the user
  // wrote to cover ONE path would then degrade every other URL on that host.
  const matching = [...(settings?.rules ?? []), ...BUILTIN_RULES].filter((candidate) =>
    hostMatches(host, candidate.host)
  )
  for (const rule of matching) {
    if (rule.strip) {
      const prefix = rule.strip.trim()
      if (prefix && url.toLowerCase().startsWith(prefix.toLowerCase())) {
        const stripped = url.slice(prefix.length).replace(/\/+$/, "")
        // An empty remainder means the rule stripped the whole URL — the host
        // is more useful than nothing.
        return { ...base, label: elideLabel(stripped || host) }
      }
    }
    if (rule.compact === "repo") {
      const label = repoLabel(parsed)
      if (label) return { ...base, label: elideLabel(label) }
    }
  }
  return { ...base, label: elideLabel(schemelessLabel(parsed)) }
}

/**
 * Parse the settings card's plain-text rule list. One rule per line, in the
 * shape the card documents:
 *
 *     github.com = https://github.com/
 *     wiki.corp.example
 *
 * Blank lines and `#` comments are ignored, and a malformed line is skipped
 * rather than rejecting the whole list — a settings field that throws away the
 * user's other nine rules because the tenth has a typo is worse than one that
 * drops the typo.
 */
export function parseLinkRules(text: string): LinkDisplayRule[] {
  const rules: LinkDisplayRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const [rawHost, ...rest] = line.split("=")
    const host = rawHost.trim().toLowerCase()
    if (!host || /\s/.test(host)) continue
    const strip = rest.join("=").trim()
    rules.push(strip ? { host, strip } : { host })
  }
  return rules
}

/** Render rules back to the card's text form (round-trips `parseLinkRules`). */
export function formatLinkRules(rules: readonly LinkDisplayRule[]): string {
  return rules.map((rule) => (rule.strip ? `${rule.host} = ${rule.strip}` : rule.host)).join("\n")
}
