import { transport } from "@/lib/tauri"

export const CHROMIUM_BROWSERS = ["chrome", "edge", "brave", "chromium"] as const
export type ChromiumBrowser = (typeof CHROMIUM_BROWSERS)[number]

export type CookieImportAvailability = {
  supported: boolean
  profiles: string[]
  reason: "feature_disabled" | "macos_only" | "no_profiles" | "probe_failed" | null
}

export type CookieImportResult =
  | { kind: "ok"; injected: number; names: string[]; domains: string[] }
  | { kind: "unsupported"; reason: "feature_disabled" | "macos_only" | string }
  | { kind: "permission_denied" }
  | { kind: "no_profile" }
  | { kind: "no_matching_cookies" }

export type CookieImportMessage = {
  key: string
  values?: { count: number }
}

const FEATURE_DISABLED: CookieImportAvailability = {
  supported: false,
  profiles: [],
  reason: "feature_disabled",
}

export async function isChromeCookieImportAvailable(
  browser: ChromiumBrowser,
  featureEnabled: boolean
): Promise<CookieImportAvailability> {
  if (!featureEnabled) return FEATURE_DISABLED
  return transport.call<CookieImportAvailability>("browser_cookie_import_available", { browser })
}

export async function importChromeCookies(args: {
  browser: ChromiumBrowser
  profile: string
  domain: string
  featureEnabled: boolean
}): Promise<CookieImportResult> {
  if (!args.featureEnabled) {
    return { kind: "unsupported", reason: "feature_disabled" }
  }
  return transport.call<CookieImportResult>("browser_cookie_import", {
    browser: args.browser,
    profile: args.profile,
    domain: args.domain,
  })
}

export function cookieImportMessage(result: CookieImportResult): CookieImportMessage {
  switch (result.kind) {
    case "ok":
      return { key: "result.ok", values: { count: result.injected } }
    case "unsupported":
      return {
        key: result.reason === "feature_disabled" ? "result.featureDisabled" : "result.unsupported",
      }
    case "permission_denied":
      return { key: "result.permissionDenied" }
    case "no_profile":
      return { key: "result.noProfile" }
    case "no_matching_cookies":
      return { key: "result.noMatchingCookies" }
  }
}
