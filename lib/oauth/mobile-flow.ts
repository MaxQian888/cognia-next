"use client"

import { open as openBrowser, close as closeBrowser } from "@/lib/capacitor/browser"
import {
  parseDeeplink,
  subscribe as subscribeDeeplink,
  type DeeplinkRoute,
} from "@/lib/capacitor/deeplink"

/**
 * Mobile-side OAuth flow orchestrator (Wave 1.8).
 *
 * Two modes baked into one entry point:
 *
 * 1. **Deep-link mode** — redirectUri is `cognia://oauth/<provider>`. The
 *    helper opens the authorize URL in `@capacitor/browser`, then listens
 *    for the matching deeplink and resolves with `{ code, state }`. Used
 *    by our own connector OAuth flows where we control the redirect.
 *
 * 2. **Manual mode** — redirectUri is an https page that displays the code
 *    after authorization. The helper resolves an external listener (passed
 *    in by the caller) so the UI can prompt the user to paste. This is the
 *    path for Anthropic Claude OAuth — Anthropic doesn't allow custom URL
 *    schemes for the public client.
 *
 * Both modes share `awaitCallback` which has a configurable timeout so the
 * OAuth dialog doesn't leak listeners forever.
 */

export interface AwaitCallbackOptions {
  /** The provider key encoded in the deeplink path (`cognia://oauth/<provider>`). */
  provider: string
  /** Timeout in ms — defaults to 5 minutes (matches typical authorize page lifespan). */
  timeoutMs?: number
  /**
   * Optional manual-paste resolver. When provided, the helper races
   * deeplink against this — whichever resolves first wins. Use this in
   * "manual paste" mode where the user reads the code off a redirect page
   * and pastes back into a form.
   */
  manualPaste?: () => Promise<{ code: string; state: string | null }>
  /** Override deeplink subscription (for tests). */
  subscribe?: typeof subscribeDeeplink
}

export interface CallbackResult {
  code: string
  state: string | null
  via: "deeplink" | "manual"
}

export type CallbackOutcome =
  | { kind: "ok"; result: CallbackResult }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "mismatch" }

/**
 * Wait for the OAuth callback to arrive. Returns when EITHER:
 *   - a deeplink for `cognia://oauth/<provider>` arrives (returns kind=ok via=deeplink)
 *   - the manualPaste resolver returns (returns kind=ok via=manual)
 *   - the timeout elapses (returns kind=timeout)
 */
export async function awaitCallback(opts: AwaitCallbackOptions): Promise<CallbackOutcome> {
  const { provider, timeoutMs = 5 * 60_000, manualPaste, subscribe = subscribeDeeplink } = opts

  return new Promise<CallbackOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: CallbackOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const finish = (result: CallbackResult) => settle({ kind: "ok", result })

    let unsubDeeplink: (() => void) | null = null
    void subscribe((route: DeeplinkRoute) => {
      if (route.kind !== "oauth_callback") return
      if (route.provider !== provider) return
      if (!route.code) {
        settle({ kind: "mismatch" })
        return
      }
      finish({ code: route.code, state: route.state, via: "deeplink" })
    })
      .then((u) => {
        if (settled) {
          u()
          return
        }
        unsubDeeplink = u
      })
      .catch(() => {
        // No deeplink available; manual is the only path.
      })

    if (manualPaste) {
      void manualPaste().then(({ code, state }) => {
        finish({ code, state, via: "manual" })
      })
    }

    const timer = setTimeout(() => {
      settle({ kind: "timeout" })
    }, timeoutMs)

    void Promise.resolve().then(() => {
      // After settle, clean up.
      const cleanup = () => {
        clearTimeout(timer)
        if (unsubDeeplink) unsubDeeplink()
      }
      // Trampoline cleanup once `settled` flips.
      const interval = setInterval(() => {
        if (settled) {
          cleanup()
          clearInterval(interval)
        }
      }, 250)
    })
  })
}

export interface RunOAuthOptions {
  authorizeUrl: string
  /**
   * The path component after `cognia://oauth/` we expect, e.g. "claude" or
   * "slack-bot". Determines which appUrlOpen routes get accepted.
   */
  provider: string
  /** Optional toolbar tint for the in-app browser. */
  toolbarColor?: string
  /** See `awaitCallback`. */
  manualPaste?: () => Promise<{ code: string; state: string | null }>
  timeoutMs?: number
}

/**
 * Open the authorize URL in an in-app browser and return the callback
 * result. Closes the browser when the callback arrives.
 */
export async function runOAuth(opts: RunOAuthOptions): Promise<CallbackOutcome> {
  const browserOutcome = await openBrowser({
    url: opts.authorizeUrl,
    toolbarColor: opts.toolbarColor,
    presentationStyle: "fullscreen",
  })
  // If the browser is unsupported (web/desktop), fall back to manual-only.
  // The caller has presumably surfaced the URL elsewhere already.
  if (browserOutcome.kind === "unsupported" && !opts.manualPaste) {
    return { kind: "cancelled" }
  }

  try {
    const outcome = await awaitCallback({
      provider: opts.provider,
      manualPaste: opts.manualPaste,
      timeoutMs: opts.timeoutMs,
    })
    return outcome
  } finally {
    if (browserOutcome.kind === "ok") {
      void closeBrowser()
    }
  }
}

export { parseDeeplink }
