/**
 * Canonical OS-family detection for the webview.
 *
 * `navigator.platform` is a frozen legacy string, not an OS name: every Mac —
 * Apple Silicon included — reports `MacIntel`, an iPad reports `MacIntel` too,
 * and Android reports `Linux armv8l`. Reading it raw therefore both *mislabels*
 * the machine in diagnostics and *misroutes* every "is this macOS?" gate on
 * iPadOS. This module is the one place that turns the browser's several
 * half-answers into a single OS family.
 *
 * The vocabulary deliberately matches `@tauri-apps/plugin-os`'s `platform()`
 * (`macos` / `windows` / `linux` / `ios` / `android`) so a diagnostics field
 * reads the same whether the desktop shell or the browser answered it.
 *
 * Pure leaf, like `./detect`: imports nothing, so both non-React `lib/` code
 * and React hooks can depend on it.
 */

/** OS families this app can name. `unknown` when nothing on the page says. */
export type OsFamily = "windows" | "macos" | "linux" | "ios" | "android" | "unknown"

/** The desktop-only narrowing used by surfaces that have no mobile shell. */
export type DesktopOsFamily = "windows" | "macos" | "linux" | "unknown"

/**
 * The three half-answers a webview offers, captured together so the decision
 * below is a pure function of them (and therefore testable without globals).
 */
export interface OsProbe {
  /** `navigator.userAgentData.platform` — Chromium only, but authoritative. */
  uaDataPlatform?: string
  /** `navigator.userAgent` — present everywhere, ambiguous on iPadOS. */
  userAgent?: string
  /** `navigator.platform` — legacy, frozen, last resort. */
  legacyPlatform?: string
  /** `navigator.maxTouchPoints` — the only way to tell an iPad from a Mac. */
  maxTouchPoints?: number
}

interface NavigatorUaData {
  platform?: unknown
}

/** Read the probe off `navigator`. Safe on the server and in odd WebViews. */
export function readOsProbe(): OsProbe {
  if (typeof navigator === "undefined") return {}
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUaData }).userAgentData
  return {
    uaDataPlatform: typeof uaData?.platform === "string" ? uaData.platform : undefined,
    userAgent: typeof navigator.userAgent === "string" ? navigator.userAgent : undefined,
    legacyPlatform: typeof navigator.platform === "string" ? navigator.platform : undefined,
    maxTouchPoints: typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0,
  }
}

/**
 * Resolve a probe to one family. Pure.
 *
 * Order matters and is not alphabetical: Android's user agent also says
 * `Linux`, and iPadOS's says `Macintosh`, so the more specific family has to
 * be decided first or it is swallowed by the more generic one.
 */
export function osFamilyFrom(probe: OsProbe): OsFamily {
  const uaData = probe.uaDataPlatform?.trim().toLowerCase() ?? ""
  const ua = probe.userAgent ?? ""
  const legacy = probe.legacyPlatform ?? ""

  if (uaData) {
    if (uaData === "android") return "android"
    if (uaData === "ios" || uaData === "ipados") return "ios"
    if (uaData === "windows") return "windows"
    if (uaData === "macos" || uaData === "mac os x") return "macos"
    if (uaData === "linux" || uaData === "chrome os" || uaData === "chromium os") return "linux"
    // Any other value ("Unknown", a future family) falls through to the
    // sniffs rather than being reported as a family we cannot name.
  }

  if (/Android/i.test(ua)) return "android"
  if (/iPhone|iPad|iPod/i.test(ua) || /^(iPhone|iPad|iPod)/i.test(legacy)) return "ios"

  const looksMac = /Mac OS X|Macintosh/i.test(ua) || /^Mac/i.test(legacy)
  // An iPad in desktop mode is indistinguishable from a Mac except for the
  // touch digitiser: no Mac reports more than one touch point.
  if (looksMac && (probe.maxTouchPoints ?? 0) > 1) return "ios"
  if (looksMac) return "macos"

  if (/Windows|Win32|Win64|WOW64/i.test(ua) || /^Win/i.test(legacy)) return "windows"
  if (/CrOS|X11|Linux/i.test(ua) || /^Linux/i.test(legacy)) return "linux"

  return "unknown"
}

/** The live OS family of this webview. */
export function detectOsFamily(): OsFamily {
  return osFamilyFrom(readOsProbe())
}

/**
 * The live OS family for surfaces whose vocabulary is desktop-only (the tray,
 * plugin context keys). Mobile answers as `unknown` rather than being coerced
 * into a desktop family it is not.
 */
export function detectDesktopOsFamily(): DesktopOsFamily {
  const family = detectOsFamily()
  return family === "ios" || family === "android" ? "unknown" : family
}

/** True on macOS proper — an iPad reporting `MacIntel` is not macOS. */
export function isMacOs(): boolean {
  return detectOsFamily() === "macos"
}

/**
 * Does this device's keyboard carry the Apple modifier glyphs (⌘ ⌥ ⇧ ⌃)?
 *
 * A DIFFERENT question from {@link isMacOs}, and the reason it has its own
 * name: iPadOS is not macOS — it is correctly `ios` above, and every "is this
 * a Mac?" gate must keep saying no for it — but a Magic Keyboard attached to
 * an iPad is labelled ⌘ and ⌥ exactly like a Mac's. Answering the glyph
 * question with the OS family printed `Ctrl+K` on keys that say ⌘.
 */
export function usesAppleModifierGlyphs(): boolean {
  const family = detectOsFamily()
  return family === "macos" || family === "ios"
}

/** True on Linux proper (Chrome OS included). */
export function isLinuxOs(): boolean {
  return detectOsFamily() === "linux"
}
