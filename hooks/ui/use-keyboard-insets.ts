"use client"

import { useMemo, useSyncExternalStore } from "react"

import {
  CLOSED_KEYBOARD_SNAPSHOT,
  keyboardViewport,
  type KeyboardViewportSnapshot,
} from "@/lib/capacitor/keyboard-viewport"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useCoarsePointer } from "@/hooks/ui/use-pointer"
import { usePlatform } from "@/hooks/use-platform"

/**
 * Soft-keyboard state with two deliberately different fields:
 *
 * - `keyboardHeight` — how many pixels of the keyboard OVERLAP the layout
 *   viewport (`innerHeight - visualViewport.height - offsetTop`). This is the
 *   extra bottom offset positioning code needs (share target, pair step).
 *   Under the shipped native frame resize (`Keyboard.resize: "native"` on iOS,
 *   Capacitor 8 `SystemBars` IME padding on Android) the OS resizes the whole
 *   WebView, so the true overlap is 0 — consumers must NOT be pushed up again.
 *
 * - `isVisible` — whether the soft keyboard is OPEN. Under a native resize the
 *   viewport delta stays ~0 even while typing, so open-state driven UI (hiding
 *   the tab bar) can't rely on the overlap. The native `@capacitor/keyboard`
 *   events are authoritative for this field whenever the plugin is available;
 *   the overlap (> 0) is the fallback signal for mobile browsers / PWA where
 *   the plugin never registers.
 *
 * Both read the one page-wide store in `lib/capacitor/keyboard-viewport.ts`,
 * which also publishes `--keyboard-inset` / `--visual-viewport-height` /
 * `html[data-keyboard]` for CSS. Any number of consumers share one set of
 * listeners.
 *
 * Active on a soft-keyboard device: the Capacitor shell, or a phone-shaped
 * layout driven by a finger (a phone browser / PWA). A narrow desktop window
 * has no soft keyboard and stays at the zero state, as does SSR.
 *
 * iOS WKWebView has historical bugs around `visualViewport` and input
 * auto-zoom; pair this hook with `font-size: 16px` on inputs to avoid
 * triggering the zoom path.
 */
export interface KeyboardInsets {
  keyboardHeight: number
  isVisible: boolean
}

const subscribeNoop = () => () => {}
const closedSnapshot = () => CLOSED_KEYBOARD_SNAPSHOT

/** Whether this device has a soft keyboard worth tracking. */
export function useSoftKeyboardDevice(): boolean {
  const platform = usePlatform()
  const compact = useCompactLayout()
  const coarse = useCoarsePointer()
  return platform === "mobile" || (compact && coarse)
}

/**
 * The full keyboard snapshot (open state, overlap, visible height, native
 * height). The zero state when `enabled` is false or the device has no soft
 * keyboard.
 */
export function useKeyboardViewport(enabled = true): KeyboardViewportSnapshot {
  const softKeyboard = useSoftKeyboardDevice()
  const active = enabled && softKeyboard
  return useSyncExternalStore(
    active ? keyboardViewport.subscribe : subscribeNoop,
    active ? keyboardViewport.getSnapshot : closedSnapshot,
    closedSnapshot
  )
}

export function useKeyboardInsets(): KeyboardInsets {
  const { overlap, open } = useKeyboardViewport()
  return useMemo(() => ({ keyboardHeight: overlap, isVisible: open }), [overlap, open])
}
