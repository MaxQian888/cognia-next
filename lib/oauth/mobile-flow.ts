"use client"

import { open as openBrowser, close as closeBrowser, onClose } from "@/lib/capacitor/browser"
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

/**
 * What a deep link means to the flow that is waiting. `null` is "not mine,
 * keep waiting", `"mismatch"` is "mine but wrong" (a callback without a code,
 * or one minted for another state), an `error` is the provider refusing, and
 * a code settles the wait.
 */
export type CallbackAccept = (
  route: DeeplinkRoute
) => { code: string; state: string | null } | { error: string } | "mismatch" | null

/** The historical rule: `cognia://oauth/<provider>` for the named provider. */
export function acceptOAuthCallbackFor(provider: string): CallbackAccept {
  return (route) => {
    if (route.kind !== "oauth_callback") return null
    if (route.provider !== provider) return null
    if (!route.code) return "mismatch"
    return { code: route.code, state: route.state }
  }
}

export interface AwaitCallbackOptions {
  /** The provider key encoded in the deeplink path (`cognia://oauth/<provider>`). */
  provider: string
  /** Which deep links settle this wait. Defaults to `acceptOAuthCallbackFor(provider)`. */
  accept?: CallbackAccept
  /** Timeout in ms — defaults to 5 minutes (matches typical authorize page lifespan). */
  timeoutMs?: number
  /**
   * Optional manual-paste resolver. When provided, the helper races
   * deeplink against this — whichever resolves first wins. Use this in
   * "manual paste" mode where the user reads the code off a redirect page
   * and pastes back into a form.
   */
  manualPaste?: () => Promise<{ code: string; state: string | null }>
  signal?: AbortSignal
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
  | { kind: "error"; error: string }

/**
 * Wait for the OAuth callback to arrive. Returns when EITHER:
 *   - a deeplink for `cognia://oauth/<provider>` arrives (returns kind=ok via=deeplink)
 *   - the manualPaste resolver returns (returns kind=ok via=manual)
 *   - the timeout elapses (returns kind=timeout)
 */
function createCallbackWait(opts: AwaitCallbackOptions) {
  let settled = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (outcome: CallbackOutcome) => void
  const outcome = new Promise<CallbackOutcome>((done) => {
    resolve = done
  })
  const settle = (result: CallbackOutcome) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    unsubscribe?.()
    opts.signal?.removeEventListener("abort", cancel)
    resolve(result)
  }
  const cancel = () => settle({ kind: "cancelled" })
  opts.signal?.addEventListener("abort", cancel, { once: true })
  if (opts.signal?.aborted) cancel()
  const accept = opts.accept ?? acceptOAuthCallbackFor(opts.provider)
  const ready = settled
    ? Promise.resolve()
    : Promise.resolve()
        .then(() =>
          (opts.subscribe ?? subscribeDeeplink)((route) => {
            const verdict = accept(route)
            if (verdict === null) return
            if (verdict === "mismatch") settle({ kind: "mismatch" })
            else if ("error" in verdict) settle({ kind: "error", error: verdict.error })
            else settle({ kind: "ok", result: { ...verdict, via: "deeplink" } })
          })
        )
        .then((remove) => {
          if (!remove) return
          if (settled) remove()
          else unsubscribe = remove
        })
        .catch(() => {
          if (!opts.manualPaste)
            settle({ kind: "error", error: "OAuth callback listener unavailable" })
        })
  if (!settled) {
    timer = setTimeout(() => settle({ kind: "timeout" }), opts.timeoutMs ?? 5 * 60_000)
    if (opts.manualPaste) {
      void Promise.resolve()
        .then(opts.manualPaste)
        .then(
          (result) => settle({ kind: "ok", result: { ...result, via: "manual" } }),
          () => cancel()
        )
    }
  }
  return { outcome, ready, settle, isSettled: () => settled }
}

export async function awaitCallback(opts: AwaitCallbackOptions): Promise<CallbackOutcome> {
  return createCallbackWait(opts).outcome
}

export interface RunOAuthOptions {
  authorizeUrl: string
  /**
   * The path component after `cognia://oauth/` we expect, e.g. "claude" or
   * "slack-bot". Determines which appUrlOpen routes get accepted.
   */
  provider: string
  /** See `awaitCallback`. */
  accept?: CallbackAccept
  /** Optional toolbar tint for the in-app browser. */
  toolbarColor?: string
  /** See `awaitCallback`. */
  manualPaste?: () => Promise<{ code: string; state: string | null }>
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Open the authorize URL in an in-app browser and return the callback
 * result. Closes the browser when the callback arrives.
 */
// The native browser is process-global; an old flow must not close a newer one.
let activeBrowserOwner: symbol | undefined

export async function runOAuth(opts: RunOAuthOptions): Promise<CallbackOutcome> {
  const wait = createCallbackWait(opts)
  let removeClose: (() => void) | undefined
  const owner = Symbol("oauth-browser")
  let openRequested = false
  let finished = false
  const closeOwnedBrowser = () => {
    if (activeBrowserOwner === owner) void closeBrowser()
  }
  try {
    // Both listeners must be installed before a fast native redirect can fire.
    const closeReady = onClose(() => {
      // Manual-code flows need to leave the browser to paste into the app.
      if (!opts.manualPaste) wait.settle({ kind: "cancelled" })
    }).then((remove) => {
      if (wait.isSettled()) remove()
      else removeClose = remove
    })
    await Promise.race([Promise.all([closeReady, wait.ready]), wait.outcome])
    if (wait.isSettled()) return await wait.outcome
    activeBrowserOwner = owner
    openRequested = true
    const opening = openBrowser({
      url: opts.authorizeUrl,
      toolbarColor: opts.toolbarColor,
      presentationStyle: "fullscreen",
    }).then((browserOutcome) => {
      if (finished && browserOutcome.kind === "ok") closeOwnedBrowser()
      if (browserOutcome.kind === "error") {
        wait.settle({ kind: "error", error: browserOutcome.message })
      } else if (browserOutcome.kind === "unsupported" && !opts.manualPaste) {
        wait.settle({ kind: "cancelled" })
      }
    })
    await Promise.race([opening, wait.outcome])
    return await wait.outcome
  } finally {
    finished = true
    wait.settle({ kind: "cancelled" })
    removeClose?.()
    if (openRequested) closeOwnedBrowser()
  }
}

export { parseDeeplink }
