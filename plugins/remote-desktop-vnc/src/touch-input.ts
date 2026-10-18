/**
 * Phone input for the VNC viewer (ADR-0234 Phase 3): the trackpad gesture
 * recognizer and the keysyms the key bar and soft keyboard send. Pure, so the
 * gestures are testable without a canvas.
 *
 * Trackpad mode moves a pointer the way a laptop trackpad does, which is what
 * makes a desktop usable on a phone: the finger never covers what it points
 * at, and small targets are reachable.
 *
 *  * one finger drags the pointer (relative, scaled by `speed`);
 *  * a tap clicks; a press held still for `holdMs` starts a drag that ends
 *    when the finger lifts;
 *  * a two-finger tap right-clicks; two fingers moving together scroll.
 */

/** DOM `MouseEvent.buttons` bits, which noVNC converts to RFB's mask. */
export const BUTTON_LEFT = 1
export const BUTTON_RIGHT = 2

export interface TrackpadSink {
  /** Move the pointer by a relative amount, in CSS pixels. */
  move(dx: number, dy: number): void
  /** Set which buttons are held, at the pointer. */
  buttons(mask: number): void
  /** Scroll by a vertical amount, in CSS pixels (positive is down). */
  scroll(dy: number): void
}

export interface TrackpadOptions {
  speed?: number
  tapMs?: number
  slopPx?: number
  holdMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Touch {
  x: number
  y: number
  startX: number
  startY: number
}

export class TrackpadGestures {
  private readonly touches = new Map<number, Touch>()
  private readonly speed: number
  private readonly tapMs: number
  private readonly slopPx: number
  private readonly holdMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private startedAt = 0
  private moved = false
  private dragging = false
  private twoFinger = false
  private scrolled = false
  private holdTimer: unknown = null

  constructor(
    private readonly sink: TrackpadSink,
    options: TrackpadOptions = {}
  ) {
    this.speed = options.speed ?? 1.5
    this.tapMs = options.tapMs ?? 250
    this.slopPx = options.slopPx ?? 8
    this.holdMs = options.holdMs ?? 500
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  down(id: number, x: number, y: number, now: number): void {
    this.touches.set(id, { x, y, startX: x, startY: y })
    if (this.touches.size === 1) {
      this.startedAt = now
      this.moved = false
      this.scrolled = false
      this.twoFinger = false
      this.holdTimer = this.setTimer(() => {
        this.holdTimer = null
        if (!this.moved && this.touches.size === 1 && !this.dragging) {
          this.dragging = true
          this.sink.buttons(BUTTON_LEFT)
        }
      }, this.holdMs)
      return
    }
    // A second finger: right-click or scroll, never a drag.
    this.twoFinger = true
    this.cancelHold()
  }

  move(id: number, x: number, y: number): void {
    const touch = this.touches.get(id)
    if (!touch) return
    const dx = x - touch.x
    const dy = y - touch.y
    touch.x = x
    touch.y = y
    if (Math.hypot(x - touch.startX, y - touch.startY) > this.slopPx) {
      this.moved = true
      this.cancelHold()
    }
    if (this.twoFinger) {
      // Two fingers move together: scroll by their mean vertical motion.
      if (this.moved && this.touches.size >= 2) {
        this.scrolled = true
        this.sink.scroll(-dy / this.touches.size)
      }
      return
    }
    if (dx !== 0 || dy !== 0) this.sink.move(dx * this.speed, dy * this.speed)
  }

  up(id: number, now: number): void {
    if (!this.touches.delete(id)) return
    if (this.touches.size > 0) return
    this.cancelHold()
    const quick = now - this.startedAt <= this.tapMs
    if (this.dragging) {
      this.dragging = false
      this.sink.buttons(0)
    } else if (this.twoFinger) {
      if (!this.scrolled && !this.moved && quick) this.click(BUTTON_RIGHT)
    } else if (!this.moved && quick) {
      this.click(BUTTON_LEFT)
    }
  }

  /** The system took the touch (a notification, a gesture): release everything. */
  cancel(): void {
    this.touches.clear()
    this.cancelHold()
    if (this.dragging) {
      this.dragging = false
      this.sink.buttons(0)
    }
  }

  private click(button: number): void {
    this.sink.buttons(button)
    this.sink.buttons(0)
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) {
      this.clearTimer(this.holdTimer)
      this.holdTimer = null
    }
  }
}

/** X11 keysyms the key bar sends (`X11/keysymdef.h`). */
export const KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
} as const

/**
 * The keysym for one typed character: Latin-1 maps to itself, everything
 * else to its Unicode keysym (`0x01000000 + codepoint`), as X11 defines.
 */
export function keysymForChar(char: string): number | null {
  const codepoint = char.codePointAt(0)
  if (codepoint === undefined) return null
  if (codepoint === 0x0a || codepoint === 0x0d) return KEYSYM.Return
  if (codepoint === 0x09) return KEYSYM.Tab
  if (codepoint < 0x20 || codepoint === 0x7f) return null
  if (codepoint <= 0x7e || (codepoint >= 0xa0 && codepoint <= 0xff)) return codepoint
  return 0x01000000 + codepoint
}

export type Modifier = "ctrl" | "alt" | "meta"

export const MODIFIER_KEYSYM: Record<Modifier, number> = {
  ctrl: KEYSYM.Control_L,
  alt: KEYSYM.Alt_L,
  meta: KEYSYM.Super_L,
}

/** What the viewer sends a key through: noVNC's `sendKey`. */
export type SendKey = (keysym: number, down?: boolean) => void

/**
 * Press `keysym` with the latched modifiers held around it, in the order a
 * keyboard would: modifiers down, key down and up, modifiers up in reverse.
 */
export function pressWithModifiers(
  send: SendKey,
  keysym: number,
  modifiers: readonly Modifier[]
): void {
  for (const modifier of modifiers) send(MODIFIER_KEYSYM[modifier], true)
  send(keysym, true)
  send(keysym, false)
  for (const modifier of [...modifiers].reverse()) send(MODIFIER_KEYSYM[modifier], false)
}
