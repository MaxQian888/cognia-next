// Is this share viewer the PUBLIC one, or the app's own copy of the same route?
//
// `/share/view` is not a separate app. `services/share-server/pages/README.md`
// is explicit about it: the whole static export is deployed to the share host,
// so the identical route renders for an anonymous visitor on
// `share.<domain>` and for the owner inside the desktop, mobile or browser
// shell. Every payload kind rendered so far needed no distinction, because
// viewing is all any of them offered.
//
// Two kinds now offer to WRITE: `template-definition` and `chat-template` can
// be added to the reader's own library. That action only means anything where
// there IS a library, and offering it to an anonymous visitor invites them to
// install something into a browser profile they will never open again. So the
// button is gated on this question, and the answer defaults to "no".
//
// The rule has two halves, and the second is the one that carries it:
//
//   1. A native shell (Tauri desktop, Capacitor mobile) is always the app. The
//      public deployment is a web page and cannot be either.
//   2. On the web, the page is the public viewer exactly when it is served FROM
//      the share endpoint the app would publish to. A self-hosted or
//      development app on any other origin is the app.
//
// Deliberately not `isTauri()` alone: the browser is a first-class shell here
// (`pnpm dev`, a self-hosted deployment), and gating on the native marker would
// tell every web user their own library does not exist.

/** Everything the decision needs, so it can be made without touching globals. */
export interface ShareViewerHost {
  /** The origin this page is served from, for example `https://share.cognia.cn`. */
  origin: string
  /** The share endpoint the app publishes to (`resolveShareEndpoint().baseUrl`). */
  shareBaseUrl: string
  /** True inside Tauri or a native Capacitor shell. */
  nativeShell: boolean
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Whether the viewer is running inside the app rather than on the public host.
 *
 * Fails closed: an origin that cannot be parsed, or an empty one, reads as the
 * public host, so the write action is hidden rather than offered on a page
 * whose provenance could not be established.
 */
export function shareViewerRunsInApp(host: ShareViewerHost): boolean {
  if (host.nativeShell) return true
  const pageOrigin = originOf(host.origin)
  if (!pageOrigin) return false
  const shareOrigin = originOf(host.shareBaseUrl)
  if (!shareOrigin) return true
  return pageOrigin !== shareOrigin
}

/**
 * Resolve the question against the live runtime.
 *
 * Imported lazily by the viewer route so `lib/share/config` (which reaches for
 * Dexie settings and the keyring) is not pulled into `payload-view.tsx`, which
 * also renders inside the owner's preview dialog.
 */
export async function resolveShareViewerRunsInApp(): Promise<boolean> {
  const [{ resolveShareEndpoint }, { detectPlatform }] = await Promise.all([
    import("./config"),
    import("@/lib/platform/detect"),
  ])
  const platform = detectPlatform()
  const { baseUrl } = await resolveShareEndpoint()
  return shareViewerRunsInApp({
    origin: typeof window === "undefined" ? "" : window.location.origin,
    shareBaseUrl: baseUrl,
    nativeShell: platform === "tauri" || platform === "mobile",
  })
}
