"use client"

/**
 * Let a pointerdown-activated trigger answer a bare `click` as well.
 *
 * Radix's `DropdownMenu.Trigger` toggles its menu on `pointerdown` (left
 * button, no Ctrl) and on `keydown` (Enter / Space / ArrowDown). It has no
 * `click` handler at all. A real mouse, pen or finger always produces a
 * `pointerdown` first, and keyboard users get the keydown path, so both of
 * those work. What does not work is any activation that arrives as a `click`
 * with no pointer gesture in front of it:
 *
 *  - `element.click()` and the default action an assistive technology performs
 *    when it "presses" a focused button (screen-reader activation, voice or
 *    switch control), which dispatch the click without synthesising the
 *    pointer events that precede a physical press;
 *  - automation that drives the UI with plain `click()` / mouse-event
 *    sequences (the Tauri agent-debug bridge's `act … click` among them).
 *
 * Every per-row "⋯" action menu in the app is such a trigger, so from those
 * paths the menu silently never opened, which read as "the menu only works
 * after hovering the row first".
 *
 * The fallback runs `activate` for a click that no gesture on this trigger has
 * already handled. Guards keep one physical press or key press from
 * activating twice (the trigger's own handler toggles, and the click that ends
 * the same gesture must not toggle back):
 *
 *  1. **The click's own `pointerType`.** Where the platform dispatches `click`
 *     as a `PointerEvent` (Chromium, current WebKit and Gecko), a physical
 *     press reports `"mouse"`, `"pen"` or `"touch"`; `element.click()` and
 *     assistive-technology activation report `""`.
 *  2. **An armed gesture.** A `pointerdown`, or an Enter / Space `keydown`, on
 *     the trigger arms the guard, and a click that ends that gesture consumes
 *     it. This covers platforms where `click` is still a plain `MouseEvent`,
 *     and a browser that would fire a keyboard click even though Radix
 *     prevented the keydown. The guard disarms once the gesture is over even
 *     when its click never reaches the trigger — a modal menu disables pointer
 *     events on the page, so a mouse press's click lands on `<html>`, and a
 *     keyboard open moves focus into the menu before the key comes back up:
 *     after that click (or key-up) has been dispatched anywhere in the
 *     document, on `pointercancel`, and on `contextmenu` (a long press or
 *     secondary click that ends without a click). Without the disarm, one
 *     ordinary open would leave the guard armed and swallow the next
 *     assistive-technology activation.
 *
 * A caller that calls `preventDefault()` on the click opts out of the fallback
 * for that click, mirroring how Radix composes its own handlers.
 */

import { useCallback, useEffect, useRef } from "react"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react"

/** Pointer types a physical press reports on a `click` that is a `PointerEvent`. */
const PHYSICAL_POINTER_TYPES: ReadonlySet<string> = new Set(["mouse", "pen", "touch"])

/** Keys whose `keydown` a button-like trigger handles itself. */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set(["Enter", " "])

/**
 * True when a `click` provably came from a physical pointer press, i.e. the
 * platform delivered it as a `PointerEvent` whose `pointerType` names a device.
 * `""` (programmatic / assistive activation) and a missing field (a plain
 * `MouseEvent`) both answer false; the second case is what the armed-gesture
 * guard exists for.
 */
export function isPhysicalPointerClick(nativeEvent: Event): boolean {
  const pointerType = (nativeEvent as { pointerType?: unknown }).pointerType
  return typeof pointerType === "string" && PHYSICAL_POINTER_TYPES.has(pointerType)
}

export interface ClickActivationHandlers<E extends Element> {
  onPointerDown: (event: ReactPointerEvent<E>) => void
  onPointerCancel: (event: ReactPointerEvent<E>) => void
  onKeyDown: (event: ReactKeyboardEvent<E>) => void
  onClick: (event: ReactMouseEvent<E>) => void
}

/**
 * @param activate What a click-only activation should do (for a dropdown
 * trigger: toggle the menu, exactly as Enter does). `null` disables the
 * fallback, which is what a trigger rendered outside its owning root gets.
 */
export function useClickActivationFallback<E extends Element>(
  activate: (() => void) | null
): ClickActivationHandlers<E> {
  const armedRef = useRef(false)
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

  const clearDisarmTimer = useCallback(() => {
    if (disarmTimerRef.current !== null) {
      clearTimeout(disarmTimerRef.current)
      disarmTimerRef.current = null
    }
  }, [])

  const detachGestureListeners = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
  }, [])

  const disarm = useCallback(() => {
    armedRef.current = false
    clearDisarmTimer()
    detachGestureListeners()
  }, [clearDisarmTimer, detachGestureListeners])

  // A trigger that unmounts mid-gesture (its row was filtered away) must not
  // leave document listeners or a timer behind.
  useEffect(() => disarm, [disarm])

  /**
   * Arm the guard for one gesture, ended by `endEvent` dispatched anywhere in
   * `doc`. Capture phase on the document runs before React's root listener, so
   * this sees the ending event before the trigger's own `onClick` does, and the
   * disarm is deferred to after the whole dispatch so that handler can still
   * read the guard. A microtask would run between listeners and clear it too
   * early.
   */
  const arm = useCallback(
    (doc: Document, endEvent: "click" | "keyup") => {
      disarm()
      armedRef.current = true
      const onGestureEnd = () => {
        detachGestureListeners()
        clearDisarmTimer()
        disarmTimerRef.current = setTimeout(() => {
          disarmTimerRef.current = null
          armedRef.current = false
        }, 0)
      }
      const onGestureAbandoned = () => disarm()
      doc.addEventListener(endEvent, onGestureEnd, true)
      doc.addEventListener("contextmenu", onGestureAbandoned, true)
      detachRef.current = () => {
        doc.removeEventListener(endEvent, onGestureEnd, true)
        doc.removeEventListener("contextmenu", onGestureAbandoned, true)
      }
    },
    [clearDisarmTimer, detachGestureListeners, disarm]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<E>) => arm(event.currentTarget.ownerDocument, "click"),
    [arm]
  )

  const onPointerCancel = useCallback(() => disarm(), [disarm])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<E>) => {
      if (ACTIVATION_KEYS.has(event.key)) arm(event.currentTarget.ownerDocument, "keyup")
    },
    [arm]
  )

  const onClick = useCallback(
    (event: ReactMouseEvent<E>) => {
      if (event.defaultPrevented) return
      if (armedRef.current) {
        // The click that ends a gesture this trigger already handled.
        disarm()
        return
      }
      if (isPhysicalPointerClick(event.nativeEvent)) return
      activate?.()
    },
    [activate, disarm]
  )

  return { onPointerDown, onPointerCancel, onKeyDown, onClick }
}
