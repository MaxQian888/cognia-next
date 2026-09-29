/**
 * Renderer transport for importing sign-ins from other browsers (ADR-0073,
 * amended by ADR-0201) and for signing the embedded preview out again.
 * Cookie values never cross this boundary.
 */
import { transport } from "@/lib/tauri"

/** What clearing a site's sign-in removed — counts only, never cookie data. */
export type CookieClearResult = { removed: number; domain: string }

/**
 * Remove the current site's cookies from the embedded preview.
 *
 * The way out of {@link importCookiesV2}, and deliberately not gated on the
 * import setting or consent: turning the feature off used to leave whatever it
 * had imported in place, with nothing anywhere that could remove it. `domain`
 * must be the host the preview is showing; its registrable domain is cleared.
 */
export function clearSiteCookies(domain: string): Promise<CookieClearResult> {
  return transport.call<CookieClearResult>("browser_cookie_clear", { domain })
}

/**
 * Remove every public site's cookies from the preview — "clear all data"'s
 * sign-out-everywhere. Local development hosts and the app's own origin are
 * left alone (see `browser_cookie_clear_all`).
 */
export function clearAllSiteCookies(): Promise<{ removed: number }> {
  return transport.call<{ removed: number }>("browser_cookie_clear_all", {})
}

// ---------------------------------------------------------------------------
// Import (ADR-0201): every desktop OS, Chromium browsers + Firefox + Safari, a
// site / domain-set / all scope, and an embedded or local-Chromium sink.
// Values still never leave Rust: these calls carry coordinates and return
// counts and domain names only.
// ---------------------------------------------------------------------------

export const COOKIE_SOURCE_BROWSERS = [
  "chrome",
  "edge",
  "brave",
  "chromium",
  "arc",
  "vivaldi",
  "opera",
  "firefox",
  "safari",
] as const
export type CookieSourceBrowser = (typeof COOKIE_SOURCE_BROWSERS)[number]

export type CookieSourceKind = "chromium" | "firefox" | "safari"

export type CookieSourceReason = "full_disk_access_required" | "not_installed" | "unsupported_os"

export type CookieSource = {
  browser: CookieSourceBrowser
  label: string
  kind: CookieSourceKind
  profiles: { id: string; name: string }[]
  supported: boolean
  reason: CookieSourceReason | string | null
}

export type CookieDomainCount = { domain: string; count: number }

export type CookieImportScope =
  { kind: "site"; domain: string } | { kind: "domains"; domains: string[] } | { kind: "all" }

export type CookieImportSink = "embedded" | "local"

export type CookieImportV2Result =
  | { kind: "ok"; injected: number; skippedAppBound: number; domains: string[] }
  | { kind: "permission_denied" }
  | { kind: "full_disk_access_required" }
  | { kind: "no_profile" }
  | { kind: "no_matching_cookies" }
  | { kind: "unsupported"; reason: string }

export type CookieImportV2Message = {
  key:
    | "result.ok"
    | "result.permissionDenied"
    | "result.fullDiskAccessRequired"
    | "result.noProfile"
    | "result.noMatchingCookies"
    | "result.unsupported"
  values?: { count: number; skipped: number }
}

export function listCookieSources(): Promise<CookieSource[]> {
  return transport.call<CookieSource[]>("browser_cookie_sources", {})
}

/** A profile's sites and cookie counts, read without decrypting any value. */
export function listCookieDomains(
  browser: CookieSourceBrowser | string,
  profile: string
): Promise<CookieDomainCount[]> {
  return transport.call<CookieDomainCount[]>("browser_cookie_domains", { browser, profile })
}

export function importCookiesV2(args: {
  browser: CookieSourceBrowser | string
  profile: string
  scope: CookieImportScope
  sink: CookieImportSink
  sessionId?: string
}): Promise<CookieImportV2Result> {
  return transport.call<CookieImportV2Result>("browser_cookie_import_v2", {
    browser: args.browser,
    profile: args.profile,
    scope: args.scope,
    sink: args.sink,
    sessionId: args.sessionId ?? null,
  })
}

/** macOS only: open System Settings at Privacy → Full Disk Access. */
export function openFullDiskAccessSettings(): Promise<void> {
  return transport.call<void>("browser_open_full_disk_access_settings", {})
}

export function cookieImportV2Message(result: CookieImportV2Result): CookieImportV2Message {
  switch (result.kind) {
    case "ok":
      return {
        key: "result.ok",
        values: { count: result.injected, skipped: result.skippedAppBound },
      }
    case "permission_denied":
      return { key: "result.permissionDenied" }
    case "full_disk_access_required":
      return { key: "result.fullDiskAccessRequired" }
    case "no_profile":
      return { key: "result.noProfile" }
    case "no_matching_cookies":
      return { key: "result.noMatchingCookies" }
    case "unsupported":
      return { key: "result.unsupported" }
  }
}
