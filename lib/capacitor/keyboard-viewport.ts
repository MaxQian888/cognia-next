"use client"

import { subscribeKeyboard, type KeyboardSubscription, type Unsubscribe } from "./keyboard"

/**
 * One page-wide reading of the soft keyboard, shared by every consumer.
 *
 * ## Which resize mode this assumes
 *
 * The Capacitor shell ships `Keyboard.resize: "native"` (iOS) and, on Android,
 * Capacitor 8's core `SystemBars` plugin pads the decor view by the IME inset,
 * so the OS shrinks the WebView frame itself when the keyboard opens. In that
 * mode `innerHeight` and `visualViewport.height` shrink together and the
 * keyboard overlaps nothing.
 *
 * The page cannot rely on that alone:
 *
 * - CSS `100dvh` is not guaranteed to follow a WebView frame resize (Chromium
 *   keeps viewport units on the "large" size in some keyboard paths). A shell
 *   sized `h-[100dvh]` then stays one keyboard too tall, and Chromium scrolls
 *   the root (programmatically, `overflow: hidden` or not) only far enough to
 *   show the focused textarea, leaving the composer's toolbar under the
 *   keyboard.
 * - A mobile browser / PWA (and iOS where the frame is not resized) overlays
 *   the keyboard instead: only the VISUAL viewport shrinks, and the browser
 *   pans it to the caret.
 *
 * So the store measures what is actually visible (`visualViewport`) and
 * publishes it, and layout reads the measured height instead of a viewport
 * unit. Native `keyboardWillShow/Hide` events are authoritative for the
 * open/closed state (under a native resize the overlap is 0 while open).
 * Without the plugin (a phone browser with `interactive-widget=
 * resizes-content`, which resizes the layout viewport like the native shell
 * does), "open" is inferred: an editable element has focus and the viewport
 * is at least {@link RESIZE_OPEN_THRESHOLD_PX} shorter than the tallest it has
 * been at this width.
 *
 * ## What it publishes
 *
 * - The snapshot (`useSyncExternalStore`-shaped `subscribe`/`getSnapshot`).
 * - CSS custom properties on `<html>`, so CSS can follow the keyboard without a
 *   React render:
 *   - `--keyboard-inset`: px of the LAYOUT viewport the keyboard covers (0
 *     under a native resize).
 *   - `--visual-viewport-height`: the visible height, set ONLY while the
 *     keyboard is open (unset otherwise, so `var(--visual-viewport-height,
 *     100dvh)` falls back to the viewport unit). Never set while pinch-zoomed.
 *   - `data-keyboard="open" | "closed"`.
 *
 * Listeners are attached with the first subscriber and removed with the last,
 * and the `<html>` markers are cleared on teardown.
 */

export interface KeyboardViewportSnapshot {
  /** The soft keyboard is open (native events win; overlap is the fallback). */
  open: boolean
  /**
   * Pixels of the layout viewport the keyboard covers:
   * `innerHeight - visualViewport.height - visualViewport.offsetTop`, clamped
   * at 0. Zero under a native frame resize.
   */
  overlap: number
  /** The visible height (`visualViewport.height`), or `innerHeight` without it. */
  viewportHeight: number
  /** The keyboard height the native plugin last reported while open, else 0. */
  nativeHeight: number
}

export const CLOSED_KEYBOARD_SNAPSHOT: KeyboardViewportSnapshot = Object.freeze({
  open: false,
  overlap: 0,
  viewportHeight: 0,
  nativeHeight: 0,
})

/** CSS custom property: px of the layout viewport under the keyboard. */
export const KEYBOARD_INSET_VAR = "--keyboard-inset"
/** CSS custom property: visible height while the keyboard is open. */
export const VISUAL_VIEWPORT_HEIGHT_VAR = "--visual-viewport-height"
/** `<html>` attribute carrying `"open"` / `"closed"`. */
export const KEYBOARD_ATTRIBUTE = "data-keyboard"

/**
 * A pinch zoom shrinks `visualViewport.height` too. Below this scale delta the
 * viewport is treated as unzoomed; above it the shrink is a zoom, not a
 * keyboard, and must not move the layout.
 */
const ZOOM_EPSILON = 0.01

/**
 * The smallest shrink of the viewport that reads as a soft keyboard when no
 * native event says so. Browser chrome (a URL bar collapsing) moves the
 * viewport by ~56px; the smallest phone keyboards are well over 150px.
 */
export const RESIZE_OPEN_THRESHOLD_PX = 150

/** Whether `element` takes text input (and so summons the soft keyboard). */
export function isEditableElement(element: Element | null): boolean {
  if (!element) return false
  if ((element as HTMLElement).isContentEditable) return true
  const tag = element.tagName
  if (tag === "TEXTAREA") return !(element as HTMLTextAreaElement).readOnly
  if (tag !== "INPUT") return false
  const input = element as HTMLInputElement
  if (input.readOnly || input.disabled) return false
  return !NON_TEXT_INPUT_TYPES.has((input.type || "text").toLowerCase())
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

type NativeSubscribe = (handlers: KeyboardSubscription) => Promise<Unsubscribe | null>

export interface KeyboardViewportStoreOptions {
  /** Defaults to the global `window`. */
  win?: Window
  /** Defaults to the `@capacitor/keyboard` wrapper. */
  subscribeNative?: NativeSubscribe
  /** Write the CSS variables / attribute on `<html>`. Default `true`. */
  writeCssVars?: boolean
}

export interface KeyboardViewportStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): KeyboardViewportSnapshot
}

/** `innerHeight - vv.height - vv.offsetTop`, clamped at 0; 0 while zoomed. */
export function computeKeyboardOverlap(win: Window): number {
  const vv = win.visualViewport
  if (!vv) return 0
  if (isZoomed(vv)) return 0
  const innerHeight = win.innerHeight ?? 0
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
}

function isZoomed(vv: VisualViewport): boolean {
  const scale = typeof vv.scale === "number" && Number.isFinite(vv.scale) ? vv.scale : 1
  return Math.abs(scale - 1) > ZOOM_EPSILON
}

function sameSnapshot(a: KeyboardViewportSnapshot, b: KeyboardViewportSnapshot): boolean {
  return (
    a.open === b.open &&
    a.overlap === b.overlap &&
    a.viewportHeight === b.viewportHeight &&
    a.nativeHeight === b.nativeHeight
  )
}

export function createKeyboardViewportStore(
  options: KeyboardViewportStoreOptions = {}
): KeyboardViewportStore {
  const listeners = new Set<() => void>()
  let snapshot: KeyboardViewportSnapshot = CLOSED_KEYBOARD_SNAPSHOT
  let teardown: (() => void) | null = null

  const resolveWin = (): Window | null =>
    options.win ?? (typeof window === "undefined" ? null : window)

  const writeCss = (win: Window, next: KeyboardViewportSnapshot) => {
    if (options.writeCssVars === false) return
    const root = win.document?.documentElement
    if (!root) return
    root.style.setProperty(KEYBOARD_INSET_VAR, `${next.overlap}px`)
    const vv = win.visualViewport
    if (next.open && next.viewportHeight > 0 && !(vv && isZoomed(vv))) {
      root.style.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${next.viewportHeight}px`)
    } else {
      root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
    }
    root.setAttribute(KEYBOARD_ATTRIBUTE, next.open ? "open" : "closed")
  }

  const clearCss = (win: Window) => {
    if (options.writeCssVars === false) return
    const root = win.document?.documentElement
    if (!root) return
    root.style.removeProperty(KEYBOARD_INSET_VAR)
    root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
    root.removeAttribute(KEYBOARD_ATTRIBUTE)
  }

  const start = (win: Window) => {
    let cancelled = false
    let unsubNative: Unsubscribe | null = null
    // `null` until the first native event lands; from then on the native
    // open/closed state wins over the overlap-derived fallback.
    let nativeOpen: boolean | null = null
    let nativeHeight = 0
    // The tallest viewport seen at the current width: the keyboard-closed
    // height the resize inference measures against. A width change (rotation,
    // split screen) starts over.
    let baselineWidth = -1
    let baselineHeight = 0

    const resizedOpen = (viewportHeight: number): boolean => {
      const width = win.innerWidth ?? 0
      if (width !== baselineWidth) {
        baselineWidth = width
        baselineHeight = viewportHeight
      } else if (viewportHeight > baselineHeight) {
        baselineHeight = viewportHeight
      }
      if (baselineHeight - viewportHeight < RESIZE_OPEN_THRESHOLD_PX) return false
      return isEditableElement(win.document?.activeElement ?? null)
    }

    const publish = () => {
      const vv = win.visualViewport
      const overlap = computeKeyboardOverlap(win)
      const zoomed = vv ? isZoomed(vv) : false
      const viewportHeight = Math.round(vv && !zoomed ? vv.height : (win.innerHeight ?? 0))
      const inferred = resizedOpen(viewportHeight)
      const open = nativeOpen ?? (overlap > 0 || inferred)
      const next: KeyboardViewportSnapshot = {
        open,
        overlap,
        viewportHeight,
        nativeHeight: open ? nativeHeight : 0,
      }
      writeCss(win, next)
      if (sameSnapshot(next, snapshot)) return
      snapshot = next
      for (const listener of Array.from(listeners)) listener()
    }

    // `focusout` fires before the next element is focused; reading
    // `activeElement` a tick later sees where focus actually went (field to
    // field must not read as "keyboard closed").
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    const deferPublish = () => {
      if (focusTimer !== null) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        focusTimer = null
        publish()
      }, 0)
    }

    const vv = win.visualViewport
    if (vv) {
      vv.addEventListener("resize", publish)
      vv.addEventListener("scroll", publish)
    }
    // A WebView frame resize changes `innerHeight` even where a visualViewport
    // event is late or missing (older WebViews).
    win.addEventListener("resize", publish)
    // Focus moving into / out of a text field flips the resize inference (the
    // viewport can shrink a frame before or after focus lands).
    win.document?.addEventListener("focusin", publish)
    win.document?.addEventListener("focusout", deferPublish)
    publish()

    const onShow = (info?: { keyboardHeight?: number }) => {
      nativeOpen = true
      const height = info?.keyboardHeight
      if (typeof height === "number" && Number.isFinite(height) && height > 0) {
        nativeHeight = Math.round(height)
      }
      publish()
    }
    const onHide = () => {
      nativeOpen = false
      nativeHeight = 0
      publish()
    }
    // No native plugin (web, Tauri, a wrapper stubbed without it): the
    // visualViewport signals above stay the only source, and that must never
    // take the page down, so both a missing function and a throw degrade.
    const subscribeNative = options.subscribeNative ?? subscribeKeyboard
    const handlers: KeyboardSubscription = {
      onWillShow: onShow,
      onDidShow: onShow,
      onWillHide: onHide,
      onDidHide: onHide,
    }
    let pending: Promise<Unsubscribe | null> | null = null
    try {
      pending = typeof subscribeNative === "function" ? subscribeNative(handlers) : null
    } catch {
      pending = null
    }
    void Promise.resolve(pending)
      .then((unsub) => {
        if (!unsub) return
        if (cancelled) {
          unsub()
          return
        }
        unsubNative = unsub
      })
      .catch(() => {
        // The plugin rejected: same as having none.
      })

    return () => {
      cancelled = true
      unsubNative?.()
      if (vv) {
        vv.removeEventListener("resize", publish)
        vv.removeEventListener("scroll", publish)
      }
      win.removeEventListener("resize", publish)
      win.document?.removeEventListener("focusin", publish)
      win.document?.removeEventListener("focusout", deferPublish)
      if (focusTimer !== null) clearTimeout(focusTimer)
      clearCss(win)
      snapshot = CLOSED_KEYBOARD_SNAPSHOT
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!teardown) {
        const win = resolveWin()
        if (win) teardown = start(win)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && teardown) {
          const stop = teardown
          teardown = null
          stop()
        }
      }
    },
    getSnapshot() {
      return snapshot
    },
  }
}

/** The page-wide store every hook subscribes to. */
export const keyboardViewport: KeyboardViewportStore = createKeyboardViewportStore()
