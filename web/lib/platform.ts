export type Platform = "macos" | "windows" | "linux"

/**
 * What the caller knows about the device beyond its user-agent string.
 *
 * `maxTouchPoints` is the only way to tell an iPad from a Mac: iPadOS 13+ ships
 * a desktop Safari UA on purpose, and a real Mac reports 0 while an iPad
 * reports 5. It is passed in rather than read here so this stays pure and
 * testable without a `navigator`.
 */
export interface PlatformSignals {
  maxTouchPoints?: number
}

/**
 * Guess the reader's desktop platform from a user-agent string.
 *
 * Pure and string-in/string-out so it can be tested across real UA strings
 * without a `navigator`; the component that renders the hint is the only thing
 * that touches the browser.
 *
 * Deliberately conservative. This drives a *hint* beside a call to action that
 * works on every platform, so guessing wrong is a small cost and guessing at
 * all where the string is ambiguous is not worth it:
 *
 *  - iOS and Android return `null`. Cognia is a desktop build; telling a phone
 *    reader "detected: macOS" is worse than saying nothing.
 *  - iPadOS 13+ reports a Mac-like UA, so a Mac-shaped string with touch points
 *    is treated as a tablet and returns `null`. This used to be documented as
 *    "the caller's job" and no caller ever did it, which is exactly how an iPad
 *    came to be told it was running macOS.
 *  - Chrome OS returns `null` rather than Linux: the Linux build is not what a
 *    Chromebook reader wants.
 */
export function detectPlatform(userAgent: string, signals: PlatformSignals = {}): Platform | null {
  const ua = userAgent.toLowerCase()

  // Order matters: several mobile UAs also contain a desktop token.
  if (/android/.test(ua)) return null
  if (/iphone|ipod/.test(ua)) return null
  if (/ipad/.test(ua)) return null
  if (/cros/.test(ua)) return null

  if (/windows|win32|win64/.test(ua)) return "windows"
  if (/mac os x|macintosh/.test(ua)) {
    // A Mac never reports touch points; an iPad masquerading as one does.
    return (signals.maxTouchPoints ?? 0) > 0 ? null : "macos"
  }
  if (/linux|x11|ubuntu|fedora|debian/.test(ua)) return "linux"
  return null
}
