/**
 * The PKCE drivers and redirect URI for the shell this code runs in.
 *
 * - Capacitor: the in-app browser and the native deep link. Asked first: the
 *   WebView cannot pop a window and has no https origin to land on.
 * - A browser (any profile but the desktop): a popup that lands on this
 *   origin's `/logto/callback`, with the web client. The popup is reserved
 *   when the drivers are created, so call this inside the click handler,
 *   before any await, and `abandon()` the drivers if the sign-in never starts.
 * - The desktop: the system browser, and the deep link the OS hands back to
 *   the running app. A caller with a paste box (the sign-in gate) also races
 *   a pasted callback, for a browser that never comes back.
 *
 * Logto keeps the callback its native application registered; any other
 * issuer gets the RFC 8252 reverse-domain one (ADR-0215 §2).
 */

import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import { isCapacitor as detectCapacitor } from "@/lib/platform/detect"
import { openUrl } from "@/lib/native/opener"

import { createLogtoCapacitorDrivers } from "./capacitor-drivers"
import { waitForLogtoDeepLinkCallback } from "./deep-link-callback"
import { createLogtoWebPopupDrivers } from "./web-popup"
import { nativeCallbackUriFor, type LogtoDrivers, type OidcIssuerKind } from "./client"

export interface PlatformSignInDrivers {
  drivers: LogtoDrivers
  redirectUri: string
  /** Web popups use the web application, desktop and phone the native one. */
  clientKind: "web" | "native"
}

export interface PlatformDriversOptions {
  issuerKind: OidcIssuerKind | undefined
  profile?: HostProfile
  isCapacitor?: () => boolean
  /**
   * Desktop only: a callback the person pastes, raced against the deep link.
   * Called with the request's `state` once the browser has been opened.
   */
  pasted?: (state: string) => Promise<{ code: string; state: string }>
  /** Ends the desktop's deep-link wait early, e.g. when the caller gives up. */
  signal?: AbortSignal
}

export function platformSignInDrivers(options: PlatformDriversOptions): PlatformSignInDrivers {
  const nativeRedirectUri = nativeCallbackUriFor(options.issuerKind)
  if ((options.isCapacitor ?? detectCapacitor)()) {
    return {
      drivers: createLogtoCapacitorDrivers(),
      redirectUri: nativeRedirectUri,
      clientKind: "native",
    }
  }
  const profile = options.profile ?? detectHostProfile()
  const popupCapable =
    profile !== "desktop" && typeof window !== "undefined" && typeof window.open === "function"
  if (popupCapable) {
    return {
      // Called from the sign-in button's click handler, before any await.
      drivers: createLogtoWebPopupDrivers(undefined, { reserveWindow: true }),
      redirectUri: `${window.location.origin}/logto/callback`,
      clientKind: "web",
    }
  }
  return {
    drivers: {
      openUrl: (url) => {
        void openUrl(url)
      },
      waitForCode: ({ state }) => {
        const controller = new AbortController()
        const forward = () => controller.abort()
        options.signal?.addEventListener("abort", forward, { once: true })
        const delivered = waitForLogtoDeepLinkCallback({ state, signal: controller.signal })
        const racers = options.pasted ? [delivered, options.pasted(state)] : [delivered]
        return Promise.race(racers).finally(() => {
          options.signal?.removeEventListener("abort", forward)
          controller.abort()
        })
      },
    },
    redirectUri: nativeRedirectUri,
    clientKind: "native",
  }
}
