/**
 * Renderer side of `vscode.window.state` and `vscode.window.activeColorTheme`:
 * whether the app's window is focused and in use, and whether its theme is
 * light or dark.
 *
 *   - `focused`: the document has focus.
 *   - `active`: the user used the window (focused it, pressed a key, clicked,
 *     scrolled or moved the pointer) within the last
 *     {@link WINDOW_INACTIVE_AFTER_MS}, and it is not hidden. As in VS Code,
 *     it turns true at once on activity and false after a short idle time.
 *   - `colorThemeKind`: `ColorThemeKind.Dark` (2) when the app is in dark
 *     mode (the `dark` class on `<html>`), else `Light` (1). The app has no
 *     high-contrast themes.
 *
 * A host asks once before its first extension activates
 * (`window:describeEnvironment`); every running host is told when any value
 * changes (`window:environmentChanged`).
 */

import { registerMethod } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"

/** Idle time after which the window stops counting as active. */
export const WINDOW_INACTIVE_AFTER_MS = 10_000

/** `ColorThemeKind` values. */
const LIGHT = 1
const DARK = 2

export interface VscodeWindowEnvironment {
  focused: boolean
  active: boolean
  colorThemeKind: typeof LIGHT | typeof DARK
}

export interface VscodeWindowEnvironmentDependencies {
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  /** The extensions with a running host. */
  hosts(): string[]
  /** Defaults to the global `window`. */
  target?: Window & typeof globalThis
}

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel"] as const

let current: VscodeWindowEnvironment | null = null
let teardown: (() => void) | null = null

/** The environment as it is now, without activity history (`active` follows focus). */
export function readWindowEnvironment(target: Window): VscodeWindowEnvironment {
  const { document } = target
  const focused = document.hasFocus()
  return {
    focused,
    active: focused && document.visibilityState !== "hidden",
    colorThemeKind: document.documentElement.classList.contains("dark") ? DARK : LIGHT,
  }
}

/**
 * Track the window and tell every host when it changes; `null` stops. Until
 * configured, `window:describeEnvironment` answers from the global window.
 */
export function configureVscodeWindowEnvironment(
  deps: VscodeWindowEnvironmentDependencies | null
): void {
  teardown?.()
  teardown = null
  current = null
  if (!deps) return
  const target = deps.target ?? window
  const { document } = target
  let state = readWindowEnvironment(target)
  current = state
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const publish = (next: VscodeWindowEnvironment) => {
    if (
      next.focused === state.focused &&
      next.active === state.active &&
      next.colorThemeKind === state.colorThemeKind
    ) {
      return
    }
    state = next
    current = next
    for (const pluginId of deps.hosts()) {
      void deps.sendToHost(pluginId, "window:environmentChanged", next).catch((error: unknown) =>
        appendVscodeLog(pluginId, {
          level: "warn",
          kind: "window",
          message: `Could not tell the extension the window's focus or theme changed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      )
    }
  }
  const stopIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }
  let lastActivity = 0
  const markActive = () => {
    // Pointer moves come in bursts; restarting the idle timer once a second is enough.
    const now = Date.now()
    if (state.active && idleTimer !== null && now - lastActivity < 1_000) return
    lastActivity = now
    stopIdleTimer()
    if (document.visibilityState === "hidden") return
    idleTimer = setTimeout(() => {
      idleTimer = null
      publish({ ...state, active: false })
    }, WINDOW_INACTIVE_AFTER_MS)
    publish({ ...state, active: true })
  }
  const onFocus = () => {
    publish({ ...state, focused: true })
    markActive()
  }
  const onBlur = () => publish({ ...state, focused: false })
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      stopIdleTimer()
      publish({ ...state, active: false })
    } else if (document.hasFocus()) {
      markActive()
    }
  }

  target.addEventListener("focus", onFocus)
  target.addEventListener("blur", onBlur)
  document.addEventListener("visibilitychange", onVisibility)
  for (const event of ACTIVITY_EVENTS) {
    target.addEventListener(event, markActive, { passive: true, capture: true })
  }
  const themeObserver = new target.MutationObserver(() =>
    publish({ ...state, colorThemeKind: readWindowEnvironment(target).colorThemeKind })
  )
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  if (state.active) markActive()

  teardown = () => {
    stopIdleTimer()
    themeObserver.disconnect()
    target.removeEventListener("focus", onFocus)
    target.removeEventListener("blur", onBlur)
    document.removeEventListener("visibilitychange", onVisibility)
    for (const event of ACTIVITY_EVENTS) {
      target.removeEventListener(event, markActive, { capture: true })
    }
  }
}

export function installVscodeWindowEnvironmentHandlers(): Array<() => void> {
  return [
    registerMethod("window:describeEnvironment", () => current ?? readWindowEnvironment(window)),
  ]
}
