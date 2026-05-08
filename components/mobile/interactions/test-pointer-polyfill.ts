/**
 * jsdom 26 doesn't ship a `PointerEvent` constructor, so React Testing
 * Library's `fireEvent.pointerDown` falls through to a generic Event
 * without clientX / clientY. This file installs a minimal PointerEvent
 * polyfill backed by MouseEvent so swipe / long-press / pull-to-refresh
 * tests can exercise the gesture math.
 *
 * Import once at the top of each interaction test file (`import "./test-
 * pointer-polyfill"`).
 */

if (
  typeof window !== "undefined" &&
  typeof (window as { PointerEvent?: unknown }).PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number
    pointerType: string
    isPrimary: boolean
    width: number
    height: number
    pressure: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? "mouse"
      this.isPrimary = init.isPrimary ?? true
      this.width = init.width ?? 1
      this.height = init.height ?? 1
      this.pressure = init.pressure ?? 0
    }
  }
  ;(window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
    PointerEventPolyfill
  // Element prototypes used in tests.
  const proto = Element.prototype as unknown as {
    setPointerCapture?: () => void
    releasePointerCapture?: () => void
    hasPointerCapture?: () => boolean
  }
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
}
