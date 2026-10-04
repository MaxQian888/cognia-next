/**
 * Which browser backend a shell can actually serve, and why not when it can't.
 *
 * ADR-0085 gave the browser a second engine — a real Chromium running in the
 * `services/workspace-runtime` container, driven over the companion RPC plane.
 * The preview picked between them on the *shell* (`!isTauri()`), which meant
 * the desktop could never reach it. Shell is the wrong question. The right one
 * is whether a Cognia server is reachable: the remote RPCs are
 * `target: "execution"`, and `RoutingTransport` already forwards those to an
 * active remote host.
 *
 * ADR-0201 adds two desktop backends that run the same runtime locally:
 * `local-chromium` (a Cognia-managed Chromium on loopback) and `user-chrome`
 * (the user's own Chrome attached through its consent-gated remote debugging).
 * Once local Chromium is installed it becomes the default for every page —
 * localhost included since ADR-0214, so dev servers get real tabs and DevTools
 * extensions; the embedded webview stays one click away as the lightweight
 * preview. `user-chrome` is only ever an explicit choice.
 *
 * Pure and injectable so the whole matrix is testable without a shell.
 */

import type { TrustTier } from "@/lib/browser/protocol"

export type BrowserBackend =
  "embedded" | "local-chromium" | "user-chrome" | "remote" | "web-fallback"

/** The backends the desktop can host itself (no server involved). */
export type DesktopLocalBackend = "local-chromium" | "user-chrome"

export type BrowserBackendReason =
  /** Desktop, no better choice: the embedded webview is the answer. */
  | "embedded-host"
  /** Remote Chromium is reachable and switched on. */
  | "remote-ready"
  /** The user has not switched the cloud browser on. */
  | "remote-disabled"
  /** Switched on, but nothing is there to run it. */
  | "no-remote-host"
  /** The managed local Chromium is installed and selected. */
  | "local-ready"
  /** Local Chromium was asked for but is not installed. */
  | "local-not-installed"
  /** The user's own Chrome is attachable and was chosen. */
  | "user-chrome-ready"
  /** The user's Chrome was asked for but has remote debugging off / is absent. */
  | "user-chrome-unavailable"

export interface BrowserBackendInputs {
  /** Running inside the desktop shell, where a native webview exists. */
  tauri: boolean
  /** `settings.remoteBrowserEnabled` — the user half of the two-key gate. */
  remoteBrowserEnabled: boolean
  /** A remote Cognia host is attached (ADR-0082). */
  remoteHostActive: boolean
  /** This shell is itself paired to a Cognia server (web / Capacitor). */
  webCompanionTarget: boolean
  /** `browser_local_status().installed` — the managed Chromium is on disk. */
  localChromiumInstalled: boolean
  /** A `browser_user_chrome_discover()` candidate is `available`. */
  userChromeAvailable: boolean
  /**
   * Trust tier of the page about to be shown, when known. Informational since
   * ADR-0214: localhost and public pages alike go to local Chromium once it is
   * installed.
   */
  targetTier?: TrustTier
  /**
   * Nothing to show yet (a pane with no address). The embedded webview serves
   * it rather than starting Chromium for an empty page.
   */
  idle?: boolean
}

export interface BrowserBackendDecision {
  backend: BrowserBackend
  /** True when remote Chromium could be selected right now. */
  remoteReachable: boolean
  /** True when the managed local Chromium could be selected right now. */
  localReachable: boolean
  /** True when the user's Chrome could be attached right now. */
  userChromeReachable: boolean
  reason: BrowserBackendReason
}

function reachability(inputs: BrowserBackendInputs) {
  return {
    localReachable: inputs.tauri && inputs.localChromiumInstalled,
    userChromeReachable: inputs.tauri && inputs.userChromeAvailable,
  }
}

/**
 * The shell-level answer, ignoring any preference. Off the desktop there is no
 * native webview, so an unreachable remote falls back to the sandboxed iframe.
 * On the desktop the embedded webview is both the default and the fallback, so
 * an unreachable remote is not an error — it is simply not offered.
 */
export function resolveBrowserBackend(inputs: BrowserBackendInputs): BrowserBackendDecision {
  const reachable = inputs.remoteHostActive || inputs.webCompanionTarget
  const local = reachability(inputs)
  if (!inputs.remoteBrowserEnabled) {
    return {
      backend: inputs.tauri ? "embedded" : "web-fallback",
      remoteReachable: false,
      ...local,
      reason: "remote-disabled",
    }
  }
  if (!reachable) {
    return {
      backend: inputs.tauri ? "embedded" : "web-fallback",
      remoteReachable: false,
      ...local,
      reason: "no-remote-host",
    }
  }
  return { backend: "remote", remoteReachable: true, ...local, reason: "remote-ready" }
}

/**
 * The best engine the desktop can serve on its own, without a preference:
 * local Chromium when installed, the embedded webview otherwise. Used by the
 * agent router when a public URL is authorized but the cloud is not ready.
 */
export function bestLocalDesktopBackend(
  inputs: Pick<BrowserBackendInputs, "tauri" | "localChromiumInstalled">
): "local-chromium" | "embedded" {
  return inputs.tauri && inputs.localChromiumInstalled ? "local-chromium" : "embedded"
}

/**
 * The desktop decision. A preference the user expressed wins when it can be
 * served; an unservable one falls back to the default and says why:
 *
 * - `remote` — only when reachable (ADR-0085, unchanged).
 * - `embedded` — always servable on the desktop.
 * - `local-chromium` — only once installed.
 * - `user-chrome` — only when a debuggable Chrome was discovered. It is never
 *   picked without being asked for: attaching prompts the user in Chrome.
 * - no preference — local Chromium once installed, for every page with an
 *   address; the embedded webview for an empty pane and when nothing is
 *   installed.
 */
export function resolveDesktopBackend(
  inputs: BrowserBackendInputs,
  preference: BrowserBackend | null
): BrowserBackendDecision {
  const decision = resolveBrowserBackend(inputs)
  if (!inputs.tauri) return decision
  const embeddedDefault = (): BrowserBackendDecision => ({
    ...decision,
    backend: "embedded",
    reason:
      decision.reason === "remote-disabled" || decision.reason === "no-remote-host"
        ? decision.reason
        : "embedded-host",
  })
  const automatic = (): BrowserBackendDecision => {
    if (decision.localReachable && !inputs.idle) {
      return { ...decision, backend: "local-chromium", reason: "local-ready" }
    }
    return embeddedDefault()
  }

  switch (preference) {
    case "remote":
      return decision.remoteReachable
        ? { ...decision, backend: "remote", reason: "remote-ready" }
        : automatic()
    case "embedded":
      return { ...decision, backend: "embedded", reason: "embedded-host" }
    case "local-chromium":
      return decision.localReachable
        ? { ...decision, backend: "local-chromium", reason: "local-ready" }
        : { ...embeddedDefault(), reason: "local-not-installed" }
    case "user-chrome":
      if (decision.userChromeReachable) {
        return { ...decision, backend: "user-chrome", reason: "user-chrome-ready" }
      }
      return { ...automatic(), reason: "user-chrome-unavailable" }
    case "web-fallback":
    case null:
    default:
      return automatic()
  }
}
