/**
 * React shell over {@link createSelectionController}: owns the controller's
 * lifetime and keeps its live inputs (mode, clipboard writer, notice sink)
 * current without re-creating it.
 *
 * The controller is created ONCE per frame buffer and read through a ref,
 * because tearing it down would drop the painted highlight mid-drag and orphan
 * the frame subscription. Everything that changes per render is therefore passed
 * as a getter closure over a ref, not as a constructor argument — the same
 * pattern `useGlobalKeys` uses for its own always-fresh deps.
 */
import { useEffect, useRef } from "react"

import {
  createSelectionController,
  type SelectionController,
} from "../selection/selection-controller"
import type { FrameBuffer } from "../selection/frame-buffer"
import type { CopyResult } from "../clipboard"
import type { SelectionMode } from "../../config/schema"

export interface UseTextSelectionArgs {
  /** The captured Ink frame, or undefined when the host renders without one
   * (scrollback layout, tests) — the hook then yields a null controller and the
   * feature simply never engages. */
  frames: FrameBuffer | undefined
  /** Live selection mode from config. */
  mode: SelectionMode
  /** Clipboard writer (carries the session's OSC 52 configuration). */
  copy: (text: string) => Promise<CopyResult> | CopyResult
  /** Post a transcript notice — the only way a selection reaches React state. */
  notify: (message: string) => void
  /** Turn a clipboard failure into its user-facing message. */
  failureMessage: (reason: "unavailable" | "too-large") => string
  /** Injected clock for the multi-click window. */
  now: () => number
}

/**
 * Mount the selection controller. Returns a stable ref whose `current` is the
 * controller (or null when there is no frame buffer), so callers can reach it
 * from event handlers without re-subscribing on every render.
 */
export function useTextSelection(args: UseTextSelectionArgs): {
  current: SelectionController | null
} {
  const { frames, mode, copy, notify, failureMessage, now } = args

  // Latest render's values, read by the controller's closures on each event.
  // Synced in an effect rather than during render (a render-phase ref write is
  // a side effect React may discard), which is safe here because every reader
  // is an event handler — it runs long after effects have flushed.
  const live = useRef({ mode, copy, notify, failureMessage, now })
  useEffect(() => {
    live.current = { mode, copy, notify, failureMessage, now }
  }, [mode, copy, notify, failureMessage, now])

  const controller = useRef<SelectionController | null>(null)
  useEffect(() => {
    if (!frames) {
      controller.current = null
      return
    }
    const created = createSelectionController({
      frames,
      mode: () => live.current.mode,
      copy: (text) => live.current.copy(text),
      onCopied: (chars) =>
        live.current.notify(`Copied ${chars} character${chars === 1 ? "" : "s"} to the clipboard.`),
      onCopyFailed: (reason) => live.current.notify(live.current.failureMessage(reason)),
      now: () => live.current.now(),
    })
    controller.current = created
    return () => {
      created.clear()
      created.dispose()
      controller.current = null
    }
  }, [frames])

  return controller
}
