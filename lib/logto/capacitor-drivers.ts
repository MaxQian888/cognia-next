/**
 * Logto sign-in drivers for the Capacitor shell.
 *
 * A WebView cannot pop a window: `window.open` returns null on iOS and the
 * Android WebView has no opener to post back to, so the web popup drivers
 * fail before the authorize page is even shown. The mobile shell already has
 * the right shape for this in `lib/oauth/mobile-flow.ts`: open the authorize
 * URL in the system in-app browser, wait for the `cognia://` deep link the
 * OS hands back, close the browser. These drivers put the Logto PKCE flow on
 * that path, with the redirect URI registered on the native Logto application.
 *
 * `openUrl` only remembers the URL. `runOAuth` opens the browser itself, and
 * opening it twice would leave one sheet under another.
 */

import { runOAuth as defaultRunOAuth } from "@/lib/oauth/mobile-flow"

import type { LogtoDrivers } from "./client"

/** The person closed the browser sheet or the wait ran out. Not a failure to report. */
export class LogtoSignInCancelled extends Error {
  constructor(message = "Logto sign-in was cancelled") {
    super(message)
    this.name = "LogtoSignInCancelled"
  }
}

export interface LogtoCapacitorDriverDeps {
  runOAuth?: typeof defaultRunOAuth
  /** Override the in-app browser timeout. Defaults to the flow's five minutes. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createLogtoCapacitorDrivers(deps: LogtoCapacitorDriverDeps = {}): LogtoDrivers {
  let authorizeUrl: string | null = null
  return {
    fetchImpl: deps.fetchImpl,
    openUrl: (url) => {
      authorizeUrl = url
    },
    waitForCode: async ({ state }) => {
      if (!authorizeUrl) throw new Error("Logto authorize URL was never opened")
      const outcome = await (deps.runOAuth ?? defaultRunOAuth)({
        authorizeUrl,
        provider: "logto",
        timeoutMs: deps.timeoutMs,
        accept: (route) => {
          if (route.kind !== "logto_callback") return null
          if (route.state !== state) return "mismatch"
          if (route.error) return { error: route.error }
          if (!route.code) return "mismatch"
          return { code: route.code, state }
        },
      })
      authorizeUrl = null
      switch (outcome.kind) {
        case "ok":
          return { code: outcome.result.code, state }
        case "mismatch":
          throw new Error("Logto callback state mismatch")
        case "error":
          throw new Error(`Logto authorization failed: ${outcome.error}`)
        case "timeout":
          throw new LogtoSignInCancelled("Logto sign-in timed out")
        case "cancelled":
          throw new LogtoSignInCancelled()
      }
    },
  }
}
