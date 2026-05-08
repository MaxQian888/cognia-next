"use client"

import { makeDefaultLoader } from "./_shared"

/**
 * Deep-link bridge over `@capacitor/app`. Capacitor doesn't ship a dedicated
 * deeplink plugin in v7 — the app plugin's `appUrlOpen` event is the
 * canonical channel. This wrapper:
 *
 *   1. Subscribes to `appUrlOpen` and routes URLs by scheme/path.
 *   2. Surfaces a typed `DeeplinkRoute` so the OAuth callback / share
 *      target / pair routing stay declarative.
 *   3. Falls back to a no-op subscription when running on web.
 */

export type DeeplinkRoute =
  | {
      kind: "oauth_callback"
      provider: string
      code: string | null
      state: string | null
      raw: string
    }
  | { kind: "pair_qr"; payload: string; raw: string }
  | { kind: "open_session"; sessionId: string; raw: string }
  | { kind: "share_target"; text?: string; url?: string; raw: string }
  | { kind: "unknown"; raw: string }

interface AppShape {
  addListener(
    event: "appUrlOpen",
    handler: (event: { url: string }) => void
  ): Promise<{ remove(): Promise<void> | void }>
  getLaunchUrl?(): Promise<{ url: string } | null>
}

export type AppLoader = () => Promise<AppShape>

const defaultLoader: AppLoader = makeDefaultLoader<AppShape>("@capacitor/app", "App")

const SCHEME = "cognia"

export function parseDeeplink(rawUrl: string): DeeplinkRoute {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: "unknown", raw: rawUrl }
  }

  if (url.protocol !== `${SCHEME}:`) return { kind: "unknown", raw: rawUrl }

  const host = url.hostname || url.pathname.replace(/^\/+/, "").split("/")[0] || ""
  // Trim the leading slash from the path. For URLs like cognia://oauth/claude
  // the URL parser treats `oauth` as host and `/claude` as path, so `path`
  // here is just `claude`.
  const path = url.pathname.replace(/^\/+/, "")
  const params = url.searchParams

  if (host === "oauth") {
    const provider = path || params.get("provider") || "default"
    return {
      kind: "oauth_callback",
      provider,
      code: params.get("code"),
      state: params.get("state"),
      raw: rawUrl,
    }
  }
  if (host === "pair") {
    const payload = params.get("payload") ?? path
    return { kind: "pair_qr", payload, raw: rawUrl }
  }
  if (host === "session") {
    const sessionId = path || params.get("id") || ""
    return { kind: "open_session", sessionId, raw: rawUrl }
  }
  if (host === "share") {
    return {
      kind: "share_target",
      text: params.get("text") ?? undefined,
      url: params.get("url") ?? undefined,
      raw: rawUrl,
    }
  }
  return { kind: "unknown", raw: rawUrl }
}

export type DeeplinkHandler = (route: DeeplinkRoute) => void
export type Unsubscribe = () => void

export async function subscribe(
  handler: DeeplinkHandler,
  loader: AppLoader = defaultLoader
): Promise<Unsubscribe> {
  try {
    const app = await loader()
    const listener = await app.addListener("appUrlOpen", (event) => {
      handler(parseDeeplink(event.url))
    })
    return () => {
      void listener.remove()
    }
  } catch {
    return () => {}
  }
}

export async function getLaunchRoute(
  loader: AppLoader = defaultLoader
): Promise<DeeplinkRoute | null> {
  try {
    const app = await loader()
    if (!app.getLaunchUrl) return null
    const launch = await app.getLaunchUrl()
    if (!launch || !launch.url) return null
    return parseDeeplink(launch.url)
  } catch {
    return null
  }
}
