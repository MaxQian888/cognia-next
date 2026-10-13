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
 * opening it twice would leave one sheet under another. A request naming a
 * provider whose app is installed (Feishu) is handed to that app instead.
 */

import { isAppHandoffAvailable, openInApp } from "@/lib/capacitor/app-handoff"
import { subscribeResume } from "@/lib/capacitor/app"
import { appHandoffFor } from "@/lib/oauth/app-handoff"
import { runOAuth as defaultRunOAuth, type AppHandoff } from "@/lib/oauth/mobile-flow"

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
  /** The provider app that can run this authorize request, if any. Tests swap it. */
  appHandoff?: (authorizeUrl: string) => AppHandoff | undefined
}

/**
 * A sign-in that names a provider whose app is on this phone (Feishu) runs
 * in that app, where the person is already signed in; any other runs in the
 * in-app browser. See `lib/oauth/app-handoff.ts`.
 */
export function providerAppHandoff(authorizeUrl: string): AppHandoff | undefined {
  const handoff = appHandoffFor(authorizeUrl)
  if (!handoff) return undefined
  return {
    open: async () =>
      (await isAppHandoffAvailable(handoff.target)) && openInApp(handoff.target, handoff.url),
    onReturn: (handler) => subscribeResume(handler),
  }
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
        appHandoff: (deps.appHandoff ?? providerAppHandoff)(authorizeUrl),
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
