"use client"

/**
 * One AI run, visible to both halves of the Canvas shell.
 *
 * The editor pane owns the buffer and the selection, so it is where an action
 * is launched from. The workbench's AI panel is a sibling in the right rail, so
 * it could only ever see `window` events, which is why `review` and `explain`
 * produced text that nothing rendered: the output lived in a `useState` inside
 * the editor pane and had nowhere to go.
 *
 * A context rather than a new store, because this state is per-mounted-shell
 * and dies with it. Consumers that render outside a provider (a story, a
 * focused unit test of the editor pane) get their own instance instead of
 * throwing, so `CanvasPanel` stays independently mountable.
 */

import { createContext, useContext, type ReactNode } from "react"
import { useCanvasActions, type UseCanvasActionsResult } from "@/hooks/canvas/use-canvas-actions"

const CanvasActionsContext = createContext<UseCanvasActionsResult | null>(null)

export function CanvasActionsProvider({ children }: { children: ReactNode }) {
  const actions = useCanvasActions()
  return <CanvasActionsContext.Provider value={actions}>{children}</CanvasActionsContext.Provider>
}

/**
 * The shell's run state when a provider is above, an own instance otherwise.
 *
 * The fallback hook is called unconditionally (hooks rules), which costs one
 * idle state object when a provider is present. That is the price of keeping
 * every consumer mountable on its own.
 */
export function useSharedCanvasActions(): UseCanvasActionsResult {
  const shared = useContext(CanvasActionsContext)
  const own = useCanvasActions()
  return shared ?? own
}
