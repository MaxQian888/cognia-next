/**
 * Touch-gesture helpers for the mobile Playwright projects.
 *
 * Why not `page.mouse`: dragging with a pressed mouse button across an
 * `<a href>` (workflow rows, discover cards — most swipeable rows wrap a
 * Link) starts a native HTML5 drag, which fires `dragstart` and CANCELS the
 * pointer stream — the component's onPointerMove never runs and the gesture
 * silently dies. Real phones drive these surfaces with touch, where HTML5
 * drag doesn't exist. Dispatching genuine touch events over CDP reproduces
 * production behavior: Chromium synthesizes pointer events with
 * pointerType "touch" from them.
 */

import type { Page } from "@playwright/test"

export interface DragOptions {
  /** Intermediate touchMove points. Default 12. */
  steps?: number
  /** Delay between move frames (ms). Default 16 (~60fps). */
  frameDelayMs?: number
  /** Hold time before releasing at the end point (ms). Default 0. */
  holdMs?: number
}

/** Touch-drag from `from` to `to` in viewport coordinates. */
export async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { steps = 12, frameDelayMs = 16, holdMs = 0 }: DragOptions = {}
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    })
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y }],
      })
      await page.waitForTimeout(frameDelayMs)
    }
    if (holdMs > 0) await page.waitForTimeout(holdMs)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}

/**
 * Touch-drag that holds at the end point WITHOUT releasing, runs `whileHeld`,
 * then releases. Lets specs assert mid-gesture state (e.g. pull-to-refresh
 * translation) exactly like a user holding a pull open.
 */
export async function touchDragHold(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  whileHeld: () => Promise<void>,
  { steps = 12, frameDelayMs = 16 }: DragOptions = {}
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    })
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y }],
      })
      await page.waitForTimeout(frameDelayMs)
    }
    await whileHeld()
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}
