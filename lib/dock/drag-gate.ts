/**
 * Coalesce dockview's layout emissions into one commit per gesture.
 *
 * `onDidLayoutChange` fires on every intermediate state of a drag or a resize
 * — dozens of times per second, none of them a state the user asked for. The
 * gate swallows those while a gesture is in flight and releases exactly one
 * change when it settles, which is what keeps "no persistence during a drag;
 * one write after a complete mutation" true rather than aspirational.
 *
 * It also debounces the emissions that arrive *outside* a gesture: dockview
 * reports a resize as a burst of changes with no begin/end signal at all, so
 * without a quiet period a slow drag of a splitter would still produce a commit
 * per frame.
 */

export interface DockDragGateOptions {
  /** Called once per settled change, with the reason it settled. */
  onSettled: (reason: DockDragSettleReason) => void
  /** Quiet period before an ungated burst counts as settled. Default 120ms. */
  quietMs?: number
  /** Injectable for tests. Defaults to `setTimeout`/`clearTimeout`. */
  schedule?: (fn: () => void, ms: number) => number
  cancel?: (handle: number) => void
}

export type DockDragSettleReason = "gesture-end" | "quiet"

export interface DockDragGate {
  /** A drag or an explicit gesture started; suppress emissions until it ends. */
  beginGesture: () => void
  /** The gesture ended; flush one settled change if anything was suppressed. */
  endGesture: () => void
  /** dockview reported a layout change. */
  notifyLayoutChange: () => void
  /** Whether a gesture is currently suppressing emissions. */
  isDragging: () => boolean
  /** Drop any pending timer. Call on unmount so a flush cannot outlive the host. */
  dispose: () => void
}

const DEFAULT_QUIET_MS = 120

export function createDockDragGate(options: DockDragGateOptions): DockDragGate {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number)
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))

  let dragging = false
  /** A change arrived while a gesture was in flight and still owes a commit. */
  let pendingDuringGesture = false
  let quietTimer: number | null = null
  let disposed = false

  const clearQuietTimer = () => {
    if (quietTimer === null) return
    cancel(quietTimer)
    quietTimer = null
  }

  const armQuietTimer = () => {
    clearQuietTimer()
    quietTimer = schedule(() => {
      quietTimer = null
      if (disposed) return
      options.onSettled("quiet")
    }, quietMs)
  }

  return {
    beginGesture: () => {
      if (disposed) return
      dragging = true
      // A burst that was mid-quiet-period when the drag began belongs to the
      // gesture now; flushing it separately would write an intermediate state.
      clearQuietTimer()
    },
    endGesture: () => {
      if (disposed || !dragging) return
      dragging = false
      if (!pendingDuringGesture) return
      pendingDuringGesture = false
      options.onSettled("gesture-end")
    },
    notifyLayoutChange: () => {
      if (disposed) return
      if (dragging) {
        pendingDuringGesture = true
        return
      }
      armQuietTimer()
    },
    isDragging: () => dragging,
    dispose: () => {
      disposed = true
      dragging = false
      pendingDuringGesture = false
      clearQuietTimer()
    },
  }
}
