/**
 * Is this connection one a user would mind spending several megabytes on?
 *
 * The daily fetch is unattended, and on a phone it can be a multi-megabyte pull
 * over cellular that the user never asked for at that moment. The `wifiOnly`
 * setting needs SOME way to answer that question, and the honest answer is that
 * the web platform only offers hints.
 *
 * So the contract here is deliberately conservative in one direction only:
 *
 *   - Where the platform SAYS the connection is metered or slow, we believe it
 *     and hold the fetch.
 *   - Where the platform says nothing (the API is missing, which is every
 *     WebKit-based shell), we allow the fetch. Refusing by default would make
 *     `wifiOnly` mean "never fetch on a Mac", which is not what the label says.
 *
 * The Network Information API is Chromium-only in practice, which covers the
 * Android shell and Windows WebView2, the two places the question actually
 * bites.
 */

/** The subset of `navigator.connection` this module reads. */
interface NetworkInformationLike {
  /** User asked the OS or browser for reduced data use. */
  saveData?: boolean
  /** `slow-2g` | `2g` | `3g` | `4g`. */
  effectiveType?: string
  /** `cellular` | `wifi` | `ethernet` | `none` | `unknown` and friends. */
  type?: string
}

/** Connection types that cost money per byte. */
const METERED_TYPES = new Set(["cellular", "wimax"])

/** Effective types slow enough that a multi-megabyte pull is a bad idea. */
const SLOW_EFFECTIVE_TYPES = new Set(["slow-2g", "2g"])

export function readNetworkInformation(): NetworkInformationLike | null {
  if (typeof navigator === "undefined") return null
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike
    mozConnection?: NetworkInformationLike
    webkitConnection?: NetworkInformationLike
  }
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null
}

/**
 * Whether the daily fetch should hold off on this connection.
 *
 * Returns `false` when nothing is known, which is the permissive answer. See
 * the module comment for why that direction is the right one.
 */
export function isLikelyMeteredConnection(
  info: NetworkInformationLike | null = readNetworkInformation()
): boolean {
  if (!info) return false
  // An explicit data-saver request is the clearest signal there is, and it is
  // the user speaking rather than the network being guessed at.
  if (info.saveData === true) return true
  if (typeof info.type === "string" && METERED_TYPES.has(info.type.toLowerCase())) return true
  if (
    typeof info.effectiveType === "string" &&
    SLOW_EFFECTIVE_TYPES.has(info.effectiveType.toLowerCase())
  ) {
    return true
  }
  return false
}

/** Whether the shell believes it is online at all. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true
  return navigator.onLine !== false
}
