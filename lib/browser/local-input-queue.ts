/**
 * The user's mouse and keyboard on the local Chromium canvas, delivered to the
 * runtime's `browser.input` one at a time.
 *
 * Each event is a separate IPC call and loopback request, and those run
 * concurrently: fired independently, a `mouseReleased` could reach Chromium
 * before its `mousePressed`, and a trackpad's 60–120 wheel events a second
 * piled up faster than they were dispatched. So events go out strictly in the
 * order they happened, and while one is in flight the waiting ones coalesce:
 *
 * - consecutive pointer moves keep only the latest position (the final hover
 *   position always arrives, unlike dropping moves while one was in flight);
 * - consecutive wheel events at the same modifiers sum their deltas into one
 *   scroll at the latest position, so a fast fling scrolls as far, in fewer
 *   round trips.
 *
 * Presses, releases and keys are never merged or dropped.
 */

export interface LocalBrowserInput {
  kind: "mouse" | "key"
  payload: Record<string, unknown>
}

export interface LocalInputQueue {
  send: (input: LocalBrowserInput) => void
  dispose: () => void
}

function isMouse(input: LocalBrowserInput, type: string): boolean {
  return input.kind === "mouse" && input.payload.type === type
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** `next` folded into the waiting `last`, or null when they must stay apart. */
function coalesce(last: LocalBrowserInput, next: LocalBrowserInput): LocalBrowserInput | null {
  if (isMouse(last, "mouseMoved") && isMouse(next, "mouseMoved")) return next
  if (
    isMouse(last, "mouseWheel") &&
    isMouse(next, "mouseWheel") &&
    (last.payload.modifiers ?? 0) === (next.payload.modifiers ?? 0)
  ) {
    return {
      kind: "mouse",
      payload: {
        ...next.payload,
        deltaX: numeric(last.payload.deltaX) + numeric(next.payload.deltaX),
        deltaY: numeric(last.payload.deltaY) + numeric(next.payload.deltaY),
      },
    }
  }
  return null
}

export function createLocalInputQueue(
  dispatch: (input: LocalBrowserInput) => Promise<unknown>
): LocalInputQueue {
  const waiting: LocalBrowserInput[] = []
  let sending = false
  let disposed = false

  const pump = async () => {
    sending = true
    try {
      while (!disposed && waiting.length > 0) {
        const input = waiting.shift()!
        // A failed event (a page mid-navigation, a dialog in the way) must not
        // stall the ones behind it.
        await dispatch(input).catch(() => undefined)
      }
    } finally {
      sending = false
    }
  }

  return {
    send(input) {
      if (disposed) return
      const last = waiting.at(-1)
      const merged = last ? coalesce(last, input) : null
      if (merged) waiting[waiting.length - 1] = merged
      else waiting.push(input)
      if (!sending) void pump()
    },
    dispose() {
      disposed = true
      waiting.length = 0
    },
  }
}
