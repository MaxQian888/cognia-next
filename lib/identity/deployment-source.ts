/**
 * Where a profile remembers *which* deployment it signs in to.
 *
 * # Why this exists
 *
 * Discovery (`deployment-discovery.ts`) can only ask a host it already knows.
 * A browser paired through `/pair` knows its host, and a headless build is the
 * host, but a desktop app or a phone pointed at a cloud deployment for the
 * first time knows nothing: the desktop's own companion server is single-user
 * by construction, and a fresh phone has no pairing. Both used to be told
 * "there is no deployment" and let straight past the sign-in gate, so the
 * cloud account was unreachable from exactly the two shells that need it most.
 *
 * The record here is the gateway's public URL plus an optional TLS fingerprint
 * for a self-signed host, the same pair `/api/auth/config` is fetched with.
 * Pairing is deliberately not the anchor: on a multi-tenant deployment the
 * pairing itself needs an OIDC token, so discovery must come first, and
 * `/api/auth/config` needs no credential at all.
 *
 * # Two keys
 *
 * A per-profile record wins, because two local profiles on one machine may
 * belong to two deployments (ADR-0054). The install-level `default` record
 * is what a fresh profile inherits, and what an end-to-end lane seeds before
 * any profile exists.
 */

const KEY_PREFIX = "cognia.cloud.deployment"
const DEFAULT_KEY = `${KEY_PREFIX}.default`
const CHANGED_EVENT = "cognia:cloud-deployment-changed"

export interface DeploymentSource {
  /** Normalized gateway origin, path prefix preserved, no trailing slash. */
  baseUrl: string
  /** SHA-256 certificate fingerprint of a self-signed host, lowercase hex. */
  fingerprint?: string
}

/** Storage seam so tests need no `localStorage`. */
export interface DeploymentSourceDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function sourceKey(localAccountId: string | null): string {
  return localAccountId ? `${KEY_PREFIX}.${localAccountId}` : DEFAULT_KEY
}

function store(deps: DeploymentSourceDeps): DeploymentSourceDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

/** `https://host[:port][/prefix]`, or `null` when the input is not a URL we can fetch. */
export function normalizeDeploymentUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // `host:27890` is a port, not a scheme. Anything else before a colon is one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?:\/\/|(?![0-9]))/i.test(trimmed)
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (!url.hostname) return null
  url.hash = ""
  url.search = ""
  url.username = ""
  url.password = ""
  return url.toString().replace(/\/+$/, "")
}

/**
 * Lowercase hex with separators dropped, or `null` when the value is not a
 * SHA-256 fingerprint. Empty input is "no fingerprint", not an error.
 */
export function normalizeDeploymentFingerprint(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  const compact = raw.replace(/[\s:]/g, "").toLowerCase()
  if (!compact) return undefined
  return /^[0-9a-f]{64}$/.test(compact) ? compact : null
}

/** A record fit to store, or `null` when either half is malformed. */
export function normalizeDeploymentSource(input: {
  baseUrl: string
  fingerprint?: string
}): DeploymentSource | null {
  const baseUrl = normalizeDeploymentUrl(input.baseUrl)
  if (!baseUrl) return null
  const fingerprint = normalizeDeploymentFingerprint(input.fingerprint)
  if (fingerprint === null) return null
  return fingerprint ? { baseUrl, fingerprint } : { baseUrl }
}

function readKey(
  local: NonNullable<DeploymentSourceDeps["local"]>,
  key: string
): DeploymentSource | null {
  const raw = local.getItem(key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
    const candidate = parsed as { baseUrl?: unknown; fingerprint?: unknown }
    if (typeof candidate.baseUrl !== "string") throw new Error("no base url")
    const normalized = normalizeDeploymentSource({
      baseUrl: candidate.baseUrl,
      ...(typeof candidate.fingerprint === "string" ? { fingerprint: candidate.fingerprint } : {}),
    })
    if (!normalized) throw new Error("malformed")
    return normalized
  } catch {
    // A record that no longer parses would send discovery to a host that does
    // not exist and show an "unavailable" screen for a typo nobody can see.
    local.removeItem(key)
    return null
  }
}

/**
 * The profile's own record, else the install-level default, else `null`.
 * Pass `null` for the profile to read only the default.
 */
export function loadDeploymentSource(
  localAccountId: string | null,
  deps: DeploymentSourceDeps = {}
): DeploymentSource | null {
  const local = store(deps)
  if (!local) return null
  if (localAccountId) {
    const own = readKey(local, sourceKey(localAccountId))
    if (own) return own
  }
  return readKey(local, DEFAULT_KEY)
}

/**
 * Store the record for a profile, or install-wide when the profile is `null`.
 * Throws on a malformed URL or fingerprint: the caller has a form to point at.
 */
export function saveDeploymentSource(
  localAccountId: string | null,
  source: { baseUrl: string; fingerprint?: string },
  deps: DeploymentSourceDeps = {}
): DeploymentSource {
  const normalized = normalizeDeploymentSource(source)
  if (!normalized) throw new Error("The deployment address is not a valid http(s) URL")
  store(deps)?.setItem(sourceKey(localAccountId), JSON.stringify(normalized))
  notify(deps)
  return normalized
}

/** Forget the profile's record (or the default when the profile is `null`). */
export function forgetDeploymentSource(
  localAccountId: string | null,
  deps: DeploymentSourceDeps = {}
): void {
  store(deps)?.removeItem(sourceKey(localAccountId))
  notify(deps)
}

function notify(deps: DeploymentSourceDeps): void {
  if (!deps.local && typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGED_EVENT))
  }
}

/** Same-tab change notifications. Storage events cover other tabs. */
export function subscribeDeploymentSource(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) listener()
  }
  window.addEventListener(CHANGED_EVENT, listener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener)
    window.removeEventListener("storage", onStorage)
  }
}
