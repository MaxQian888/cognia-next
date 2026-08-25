/**
 * Which browser backend a shell can actually serve, and why not when it can't.
 *
 * ADR-0085 gave the browser a second engine — a real Chromium running in the
 * `services/workspace-runtime` container, driven over the companion RPC plane.
 * The preview picked between them on the *shell* (`!isTauri()`), which meant
 * the desktop could never reach it, so roughly a third of the registered
 * `browser_*` tools answered `browser_feature_unsupported` no matter what, and
 * the browser profiles and domain grants the user configured in Settings had
 * no effect there at all.
 *
 * Shell is the wrong question. The right one is whether a Cognia server is
 * reachable: the remote RPCs are `target: "execution"`, and `RoutingTransport`
 * already forwards those to an active remote host. A desktop attached to one
 * (ADR-0082) can drive the cloud browser exactly like a paired phone can.
 *
 * Pure and injectable so the whole matrix is testable without a shell.
 */

export type BrowserBackend = "embedded" | "remote" | "web-fallback"

export type BrowserBackendReason =
  /** Desktop, no remote host attached: the embedded webview is the answer. */
  | "embedded-host"
  /** Remote Chromium is reachable and switched on. */
  | "remote-ready"
  /** The user has not switched the cloud browser on. */
  | "remote-disabled"
  /** Switched on, but nothing is there to run it. */
  | "no-remote-host"

export interface BrowserBackendInputs {
  /** Running inside the desktop shell, where a native webview exists. */
  tauri: boolean
  /** `settings.remoteBrowserEnabled` — the user half of the two-key gate. */
  remoteBrowserEnabled: boolean
  /** A remote Cognia host is attached (ADR-0082). */
  remoteHostActive: boolean
  /** This shell is itself paired to a Cognia server (web / Capacitor). */
  webCompanionTarget: boolean
}

export interface BrowserBackendDecision {
  backend: BrowserBackend
  /** True when remote Chromium could be selected right now. */
  remoteReachable: boolean
  reason: BrowserBackendReason
}

/**
 * Note the asymmetry, and that it is deliberate: off the desktop there is no
 * native webview, so an unreachable remote falls back to the sandboxed iframe.
 * On the desktop the embedded webview is both the default and the fallback, so
 * an unreachable remote is not an error — it is simply not offered.
 */
export function resolveBrowserBackend(inputs: BrowserBackendInputs): BrowserBackendDecision {
  const reachable = inputs.remoteHostActive || inputs.webCompanionTarget
  if (!inputs.remoteBrowserEnabled) {
    return {
      backend: inputs.tauri ? "embedded" : "web-fallback",
      remoteReachable: false,
      reason: "remote-disabled",
    }
  }
  if (!reachable) {
    return {
      backend: inputs.tauri ? "embedded" : "web-fallback",
      remoteReachable: false,
      reason: "no-remote-host",
    }
  }
  return { backend: "remote", remoteReachable: true, reason: "remote-ready" }
}

/**
 * On the desktop, remote Chromium is an opt-in *alternative* to the embedded
 * webview rather than a replacement — the embedded one keeps localhost, which
 * is what the pane is mostly used for. So the desktop gets a switch, and a
 * preference the user has expressed wins over the default.
 */
export function resolveDesktopBackend(
  inputs: BrowserBackendInputs,
  preference: BrowserBackend | null
): BrowserBackendDecision {
  const decision = resolveBrowserBackend(inputs)
  if (!inputs.tauri) return decision
  if (preference === "remote" && decision.remoteReachable) {
    return { backend: "remote", remoteReachable: true, reason: "remote-ready" }
  }
  if (preference === "embedded") {
    return { ...decision, backend: "embedded", reason: "embedded-host" }
  }
  // No preference: the embedded webview stays the desktop default (ADR-0085).
  return {
    ...decision,
    backend: "embedded",
    reason: decision.remoteReachable ? "embedded-host" : decision.reason,
  }
}
