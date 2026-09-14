/**
 * PWA install-state capture (web shell only).
 *
 * Chrome/Edge fire `beforeinstallprompt` once installability criteria are met
 * (manifest + service worker + HTTPS). The event is not repeatable: if nothing
 * calls `preventDefault()` when it fires, the custom install UI can never
 * trigger the browser prompt. So the capture listener lives at module scope,
 * attached once by `PwaLifecycleInitializer` near the top of the tree — before
 * `AccountGate`, which can hold children unmounted while the event fires.
 *
 * This module is a pure external store (no React): `subscribeInstallState` +
 * `getInstallState` plug into `useSyncExternalStore` in
 * `hooks/use-install-prompt.ts`. Every query feature-detects, so on
 * Tauri/Capacitor/SSR the state is always `unavailable`.
 */

/**
 * The parts of `BeforeInstallPromptEvent` the app uses. Not in lib.dom —
 * the event is Chromium-only and still unofficial, so we keep a minimal
 * structural type rather than a global declaration third-party types may
 * also claim.
 */
export interface BeforeInstallPromptEventLike extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

/**
 * - `installable` — the browser offered a deferred prompt; `promptInstall()`
 *   will show the native install dialog.
 * - `installed` — running inside the installed app's own window
 *   (`display-mode: standalone`) or the browser confirmed via `appinstalled`.
 * - `ios-manual` — iOS Safari: no `beforeinstallprompt` ever fires; the user
 *   installs via Share → Add to Home Screen.
 * - `unavailable` — anything else: unsupported browser, criteria unmet, or a
 *   non-web shell.
 */
export type PwaInstallStatus = "installable" | "installed" | "ios-manual" | "unavailable"

export type PwaInstallOutcome = "accepted" | "dismissed" | "unavailable"

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean
}

let deferredPrompt: BeforeInstallPromptEventLike | null = null
let installedConfirmed = false
let attachCount = 0
let detachListeners: (() => void) | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** True when this window IS an installed PWA's standalone window. */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false
  if (typeof window.matchMedia !== "function") return false
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    (window.navigator as NavigatorWithStandalone).standalone === true
  )
}

/**
 * iOS Safari — the one browser that can install (Add to Home Screen) but
 * never fires `beforeinstallprompt`. Detected by platform + the absence of
 * the Android-only `userAgentData` brands. `navigator.standalone` is the
 * iOS-specific "am I a home-screen app" flag handled by
 * {@link isStandaloneDisplayMode}.
 */
export function isIosManualInstall(): boolean {
  if (typeof window === "undefined") return false
  const ua = window.navigator.userAgent
  const isiOsDevice =
    /iP(hone|ad|od)/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in window)
  if (!isiOsDevice) return false
  // Chrome/Firefox on iOS can't install PWAs either — only Safari exposes
  // Add to Home Screen. Their UAs carry CriOS/FxiOS.
  return !/CriOS|FxiOS|EdgiOS/.test(ua)
}

export function isInstalledPwa(): boolean {
  return installedConfirmed || isStandaloneDisplayMode()
}

export function getInstallStatus(): PwaInstallStatus {
  if (isInstalledPwa()) return "installed"
  if (deferredPrompt) return "installable"
  if (isIosManualInstall()) return "ios-manual"
  return "unavailable"
}

/**
 * `useSyncExternalStore` subscribe half. Listener fires on prompt capture,
 * `appinstalled`, and `display-mode` changes (install flips the mode).
 */
export function subscribeInstallState(onChange: () => void): () => void {
  listeners.add(onChange)
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => listeners.delete(onChange)
  }
  const media = window.matchMedia("(display-mode: standalone)")
  media.addEventListener("change", onChange)
  return () => {
    listeners.delete(onChange)
    media.removeEventListener("change", onChange)
  }
}

function onBeforeInstallPrompt(event: Event): void {
  event.preventDefault()
  deferredPrompt = event as BeforeInstallPromptEventLike
  notify()
}

function onAppInstalled(): void {
  installedConfirmed = true
  deferredPrompt = null
  notify()
}

/**
 * Attach the capture listeners. Reference-counted: the lifecycle initializer
 * attaches once, and any number of consumers may attach/detach without
 * breaking the capture. No-op outside a real browser window.
 */
export function attachInstallListeners(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {}
  }
  attachCount += 1
  if (!detachListeners) {
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt)
    window.addEventListener("appinstalled", onAppInstalled)
    detachListeners = () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt)
      window.removeEventListener("appinstalled", onAppInstalled)
    }
  }
  return () => {
    attachCount = Math.max(0, attachCount - 1)
    if (attachCount === 0 && detachListeners) {
      detachListeners()
      detachListeners = null
    }
  }
}

/**
 * Show the browser's install dialog. Resolves `unavailable` when there is no
 * captured prompt (unsupported browser, criteria unmet, already dismissed).
 * The deferred event is single-use — Chrome discards it after `prompt()`,
 * so we clear it either way.
 */
export async function promptInstall(): Promise<PwaInstallOutcome> {
  const pending = deferredPrompt
  deferredPrompt = null
  notify()
  if (!pending) return "unavailable"
  try {
    await pending.prompt()
  } catch {
    // e.g. NotAllowedError when the deferred event was already consumed.
    return "unavailable"
  }
  try {
    const choice = await pending.userChoice
    return choice.outcome === "accepted" ? "accepted" : "dismissed"
  } catch {
    return "dismissed"
  }
}

/** Test seam — clears module state between cases. */
export function __resetPwaInstallStateForTests(): void {
  deferredPrompt = null
  installedConfirmed = false
  attachCount = 0
  detachListeners?.()
  detachListeners = null
  listeners.clear()
}
