"use client"

import { makeDefaultLoader } from "./_shared"
import { parseCogniaDeeplink, type CogniaDeeplinkRoute } from "@/lib/navigation/cognia-deeplink"

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

export type DeeplinkRoute = CogniaDeeplinkRoute

interface AppShape {
  addListener(
    event: "appUrlOpen",
    handler: (event: { url: string }) => void
  ): Promise<{ remove(): Promise<void> | void }>
  getLaunchUrl?(): Promise<{ url: string } | null>
}

export type AppLoader = () => Promise<AppShape>

const defaultLoader: AppLoader = makeDefaultLoader<AppShape>("@capacitor/app", "App")

export function parseDeeplink(rawUrl: string): DeeplinkRoute {
  return parseCogniaDeeplink(rawUrl)
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
