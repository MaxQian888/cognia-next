"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/keyboard` wrapper.
 *
 * The mobile shell configures `plugins.Keyboard.resize: "native"` in
 * `mobile/capacitor.config.ts` (iOS), and on Android Capacitor 8's core
 * `SystemBars` plugin pads the decor view by the IME inset; either way the OS
 * resizes the whole WebView frame when the soft keyboard opens. In that mode
 * `window.innerHeight` shrinks along with `visualViewport.height`, so the
 * visualViewport overlap the keyboard store (`keyboard-viewport.ts`) computes
 * collapses to 0 — the native `keyboardWillShow` events (which carry
 * `keyboardHeight`) are the only reliable open/closed signal. This wrapper
 * exposes those events plus imperative hide/show so UI code never imports the
 * native module directly.
 *
 * On web / Tauri every function is an inert no-op (`unsupported` outcome or
 * inert unsubscribe), matching the other `lib/capacitor/*` wrappers.
 */

export interface KeyboardInfo {
  keyboardHeight: number
}

interface KeyboardShape {
  addListener(
    event: "keyboardWillShow" | "keyboardDidShow",
    handler: (info: KeyboardInfo) => void
  ): Promise<{ remove(): Promise<void> } | { remove(): void }>
  addListener(
    event: "keyboardWillHide" | "keyboardDidHide",
    handler: () => void
  ): Promise<{ remove(): Promise<void> } | { remove(): void }>
  hide(): Promise<void>
  show(): Promise<void>
}

export type KeyboardLoader = () => Promise<KeyboardShape>

const defaultLoader: KeyboardLoader = makeDefaultLoader<KeyboardShape>(
  "@capacitor/keyboard",
  "Keyboard"
)

export type Unsubscribe = () => void

export interface KeyboardSubscription {
  /** Fires with the keyboard height as the keyboard starts opening. */
  onWillShow?: (info: KeyboardInfo) => void
  /** Fires with the final keyboard height once fully open. */
  onDidShow?: (info: KeyboardInfo) => void
  /** Fires as the keyboard starts closing. */
  onWillHide?: () => void
  /** Fires once the keyboard is fully closed. */
  onDidHide?: () => void
}

/**
 * Subscribe to native keyboard show/hide events.
 *
 * Resolves to an unsubscribe function; resolves to `null` when the native
 * plugin is unavailable (web / Tauri / plugin not registered) so callers can
 * fall back to `visualViewport` in one branch.
 */
export async function subscribeKeyboard(
  handlers: KeyboardSubscription,
  loader: KeyboardLoader = defaultLoader
): Promise<Unsubscribe | null> {
  let keyboard: KeyboardShape
  try {
    keyboard = await loader()
  } catch {
    return null
  }
  let active = true
  const removers: Array<{ remove: () => void | Promise<void> }> = []
  const removeAll = () => {
    active = false
    for (const listener of removers.splice(0)) {
      void Promise.resolve()
        .then(() => listener.remove())
        .catch(() => {})
    }
  }
  try {
    if (handlers.onWillShow) {
      removers.push(
        await keyboard.addListener("keyboardWillShow", (info) => {
          if (active) handlers.onWillShow?.(info)
        })
      )
    }
    if (handlers.onDidShow) {
      removers.push(
        await keyboard.addListener("keyboardDidShow", (info) => {
          if (active) handlers.onDidShow?.(info)
        })
      )
    }
    if (handlers.onWillHide) {
      removers.push(
        await keyboard.addListener("keyboardWillHide", () => {
          if (active) handlers.onWillHide?.()
        })
      )
    }
    if (handlers.onDidHide) {
      removers.push(
        await keyboard.addListener("keyboardDidHide", () => {
          if (active) handlers.onDidHide?.()
        })
      )
    }
    return removeAll
  } catch {
    removeAll()
    return null
  }
}

/**
 * Dismiss the soft keyboard. Used after actions that end a typing flow
 * (send, sheet open) so the content behind is fully visible again.
 */
export async function hideKeyboard(loader: KeyboardLoader = defaultLoader): Promise<SimpleOutcome> {
  return withPlugin(loader, async (keyboard) => {
    await keyboard.hide()
    return { kind: "ok" as const }
  })
}

/** Open the soft keyboard (Android only — iOS ignores programmatic show). */
export async function showKeyboard(loader: KeyboardLoader = defaultLoader): Promise<SimpleOutcome> {
  return withPlugin(loader, async (keyboard) => {
    await keyboard.show()
    return { kind: "ok" as const }
  })
}
