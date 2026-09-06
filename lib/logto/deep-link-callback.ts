/**
 * The Logto authorization callback, delivered as a deep link.
 *
 * On the desktop and on Capacitor the system browser lands on
 * `cognia://logto/callback?code=…&state=…`. The shell that receives it (the
 * Tauri `deep-link://received` listener, the cold-start launch URL, the
 * Capacitor `appUrlOpen` route) knows nothing about the PKCE flow that is
 * waiting, and the flow knows nothing about how the OS hands URLs over. This
 * module is the seam between them: a window event the shell publishes into
 * and the flow's `waitForCode` driver waits on.
 *
 * Validation stays with the waiter. A callback whose `state` is not the one
 * this flow minted is refused with the same wording the web popup uses, so an
 * unrelated or replayed link cannot complete a sign-in that did not start it.
 * A callback that arrives while nobody is waiting is dropped: a cold-started
 * app has no PKCE verifier in memory, and there is nothing to resume.
 */

import type { CogniaDeeplinkRoute } from "@/lib/navigation/cognia-deeplink"

export const LOGTO_DEEPLINK_CALLBACK_EVENT = "cognia:logto-deeplink-callback"

export type LogtoDeepLinkCallback = Extract<CogniaDeeplinkRoute, { kind: "logto_callback" }>

/** Hand a parsed `cognia://logto/callback` route to whoever is waiting. */
export function publishLogtoDeepLinkCallback(route: LogtoDeepLinkCallback): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<LogtoDeepLinkCallback>(LOGTO_DEEPLINK_CALLBACK_EVENT, { detail: route })
  )
}

export interface WaitForLogtoDeepLinkOptions {
  /** The `state` this flow put on the authorize request. */
  state: string
  /** Stops waiting. The promise then rejects with an `AbortError`. */
  signal?: AbortSignal
}

function abortError(): Error {
  const error = new Error("Logto deep-link wait aborted")
  error.name = "AbortError"
  return error
}

/**
 * Resolve with the authorization code the next time a callback for `state`
 * arrives. A callback for another state rejects (a mismatch is an answer, not
 * something to keep waiting through), and so does one carrying an `error`.
 */
export function waitForLogtoDeepLinkCallback(
  options: WaitForLogtoDeepLinkOptions
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Logto deep-link callbacks need a window"))
      return
    }
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }
    const cleanup = () => {
      window.removeEventListener(LOGTO_DEEPLINK_CALLBACK_EVENT, onCallback)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    const onCallback = (event: Event) => {
      const route = (event as CustomEvent<LogtoDeepLinkCallback>).detail
      if (!route || route.kind !== "logto_callback") return
      cleanup()
      if (route.state !== options.state) {
        reject(new Error("Logto callback state mismatch"))
      } else if (route.error) {
        reject(new Error(`Logto authorization failed: ${route.error}`))
      } else if (!route.code) {
        reject(new Error("Logto callback is missing code"))
      } else {
        resolve({ code: route.code, state: options.state })
      }
    }
    window.addEventListener(LOGTO_DEEPLINK_CALLBACK_EVENT, onCallback)
    options.signal?.addEventListener("abort", onAbort)
  })
}
