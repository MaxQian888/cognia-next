"use client"

/**
 * ConnectorDeepLinkRouter — Task 42.
 *
 * Subscribes to `cognia://connector/oauth/<adapterType>?code=…&state=…`
 * deep-link URLs forwarded by the Tauri deep-link plugin.
 *
 * For each matched URL:
 *   1. Validate `state` vs `sessionStorage["connector-oauth-state"]`.
 *   2. Look up the OAuth handler in oauthRegistry.
 *   3. Invoke the handler; toast success / error.
 *
 * Listens on the Tauri deep-link plugin on desktop and on Capacitor's
 * `appUrlOpen` (incl. cold-start launch URL) on the mobile shell — the
 * URL format and handler pipeline are identical. No-op in web mode.
 */

import { useEffect } from "react"
import { toast } from "sonner"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { getLaunchDeepLink, onDeepLink } from "@/lib/tauri/deep-link"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  getLaunchRoute as getCapacitorLaunchRoute,
  subscribe as subscribeCapacitorDeeplink,
} from "@/lib/capacitor/deeplink"
import { close as closeCapacitorBrowser } from "@/lib/capacitor/browser"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-state"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/** Matches: cognia://connector/oauth/<adapterType>?code=…&state=… */
const OAUTH_PATH_RE = /^cognia:\/\/connector\/oauth\/([^?#/]+)/

/** Read the pending OAuth state — session first, durable localStorage fallback. */
function readStoredOAuthState(): string {
  let stored = ""
  if (typeof sessionStorage !== "undefined") {
    stored = sessionStorage.getItem(CONNECTOR_OAUTH_STATE_KEY) ?? ""
  }
  if (!stored && typeof localStorage !== "undefined") {
    stored = localStorage.getItem(CONNECTOR_OAUTH_STATE_KEY) ?? ""
  }
  return stored
}

/** Clear both copies of the pending OAuth state (clear-on-use). */
function clearStoredOAuthState(): void {
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(CONNECTOR_OAUTH_STATE_KEY)
    } catch {
      // ignore
    }
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(CONNECTOR_OAUTH_STATE_KEY)
    } catch {
      // ignore
    }
  }
}

function parseOAuthUrl(raw: string): {
  adapterType: string
  code: string
  state: string
} | null {
  const match = OAUTH_PATH_RE.exec(raw)
  if (!match) return null
  const adapterType = match[1]
  let url: URL
  try {
    // URL constructor needs an http base to parse query params
    url = new URL(raw.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
  } catch {
    return null
  }
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  return { adapterType, code, state }
}

async function handleOAuthUrl(raw: string): Promise<void> {
  const parsed = parseOAuthUrl(raw)
  if (!parsed) return // not an OAuth deep-link

  const { adapterType, code, state } = parsed

  // ── Step 1: validate state (session live-path, durable cold-start fallback)
  const storedState = readStoredOAuthState()

  if (!state || state !== storedState) {
    toast.error("OAuth state mismatch")
    return
  }

  // ── Step 2: look up handler ────────────────────────────────────────────────
  const [{ oauthRegistry }, { isPlatformKind }] = await Promise.all([
    import("@/lib/connectors/oauth-registry"),
    import("@/types/connectors/platform-kind"),
  ])
  if (!isPlatformKind(adapterType)) {
    toast.error(`No OAuth handler for unknown platform: ${adapterType}`)
    return
  }

  const handler = oauthRegistry.get(adapterType as PlatformKind)
  if (!handler) {
    toast.error(`No OAuth handler for ${adapterType}`)
    return
  }

  // The state is spent — clear both copies before running the exchange.
  clearStoredOAuthState()

  // ── Step 3: invoke handler ─────────────────────────────────────────────────
  // State is forwarded so platform-specific handlers can decode an
  // adapterId out of it (Lark uses `lark:<adapterId>:<nonce>` to scope
  // the exchange to a specific configured account). ADR-0009 v41 / D2.
  try {
    await handler(code, state)
    toast.success(`${adapterType} connected successfully`)
  } catch (err) {
    toast.error(`OAuth exchange failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function ConnectorDeepLinkRouter({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (isTauri()) {
      let unlisten: (() => void) | null = null
      let cancelled = false
      // Dedup: a cold-start launch URL can also be re-delivered via onOpenUrl.
      const seen = new Set<string>()
      const dispatch = (raw: string) => {
        if (!OAUTH_PATH_RE.test(raw) || seen.has(raw)) return
        seen.add(raw)
        void handleOAuthUrl(raw)
      }

      void (async () => {
        // Cold-start: the relay may have 302'd into `cognia://` while the app
        // was closed. The pending state survives in the durable localStorage
        // mirror, so the exchange can still validate.
        const launch = await getLaunchDeepLink()
        if (!cancelled && launch) {
          for (const url of launch) dispatch(url)
        }
        unlisten = await onDeepLink((urls: string[]) => {
          for (const url of urls) dispatch(url)
        })
        if (cancelled && unlisten) {
          safeUnlisten(unlisten)
          unlisten = null
        }
      })()

      return () => {
        cancelled = true
        safeUnlisten(unlisten)
      }
    }

    if (isCapacitor()) {
      // Mobile shell: `cognia://connector/oauth/...` arrives via appUrlOpen.
      // The capacitor deeplink parser types it "unknown" (it's not one of
      // its declarative routes) — match on the raw URL instead, same as the
      // Tauri path. Cold-start launch URLs are replayed once, deduped.
      let unsub: (() => void) | null = null
      let cancelled = false
      const seen = new Set<string>()
      const dispatch = (raw: string) => {
        if (!OAUTH_PATH_RE.test(raw) || seen.has(raw)) return
        seen.add(raw)
        // The authorize page was opened in the in-app browser sheet
        // (lib/native/opener); dismiss it so the exchange toast is visible.
        void closeCapacitorBrowser()
        void handleOAuthUrl(raw)
      }

      void (async () => {
        const u = await subscribeCapacitorDeeplink((route) => dispatch(route.raw))
        if (cancelled) {
          u()
          return
        }
        unsub = u
        const launch = await getCapacitorLaunchRoute()
        if (launch && !cancelled) dispatch(launch.raw)
      })()

      return () => {
        cancelled = true
        unsub?.()
      }
    }

    return
  }, [])

  return <>{children}</>
}
