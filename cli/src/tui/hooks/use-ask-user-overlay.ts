/**
 * Bridge the `ask_user` elicitation store into the reducer-driven overlay
 * system. The agent's `ask_user` tool call round-trips through the plugin-tool
 * wire into `useAskUserStore` (the same store the desktop dialog uses); this
 * hook mirrors the store's active prompt into a `kind: "askUser"` overlay so the
 * CLI renders the AskUserDialog, and returns a `resolve` callback that settles
 * the blocked tool call and closes the overlay. Without this bridge the tool
 * call never resolves and the turn hangs.
 *
 * It opens the overlay only when nothing else is on screen (`overlayKind ===
 * "none"`); if a permission prompt is up it waits until that closes, then the
 * effect re-fires (overlayKind is a dependency) and opens the question. It
 * closes the overlay defensively if the active prompt disappears for any other
 * reason (e.g. the session resets).
 */
import { useCallback, useEffect, useMemo } from "react"

import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { AskUserAnswer } from "@/lib/claude/ask-user-tool"
import type { Overlay, TuiAction } from "../state/types"

export interface AskUserOverlayApi {
  /** Settle the active prompt with the user's answer and close the overlay. */
  resolve: (answer: AskUserAnswer) => void
}

export function useAskUserOverlay(
  overlayKind: Overlay["kind"],
  dispatch: (action: TuiAction) => void
): AskUserOverlayApi {
  const active = useAskUserStore((s) => s.active)
  const resolveActive = useAskUserStore((s) => s.resolveActive)

  useEffect(() => {
    if (active && overlayKind === "none") {
      dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "askUser", request: active.request } })
    } else if (!active && overlayKind === "askUser") {
      dispatch({ type: "OVERLAY_CLOSE" })
    }
  }, [active, overlayKind, dispatch])

  const resolve = useCallback(
    (answer: AskUserAnswer) => {
      resolveActive(answer)
      dispatch({ type: "OVERLAY_CLOSE" })
    },
    [resolveActive, dispatch]
  )

  return useMemo(() => ({ resolve }), [resolve])
}
