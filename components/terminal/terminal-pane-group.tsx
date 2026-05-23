"use client"

/**
 * Renders the split panes of a single terminal tab (group).
 *
 * Model (1A): VS Code's terminal split is a *flat* row/column of panes,
 * not an arbitrary tree. The store keeps `splitPanes[anchorId]` — the
 * ordered extra panes beside the anchor — plus a per-group orientation
 * and focused pane. This component reads that group reactively and:
 *
 *   * single pane  → render the `TerminalInstance` directly (no chrome,
 *     identical to the pre-split dock body),
 *   * ≥2 panes     → render a `ResizablePanelGroup` (orientation from the
 *     store) with one instance per pane.
 *
 * Pane sizes persist via `useResizableLayout` (the same hook the logs /
 * a2ui / canvas shells use) keyed by the anchor id — we do NOT re-implement
 * size persistence in the store.
 *
 * The focused pane drives the dock's search overlay + history rail +
 * keyboard target. We report `(focusedSessionId, focusedHandle)` upward
 * via `onFocusedChange` so the dock can keep one ref to "the active
 * instance" exactly as it did before splitting existed.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { cn } from "@/lib/utils"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { TerminalInstance, type TerminalInstanceHandle } from "./terminal-instance"

export interface TerminalPaneGroupProps {
  /** The group anchor (active tab's session id). */
  anchorId: string
  /** Reports the focused pane + its imperative handle to the dock. */
  onFocusedChange: (sessionId: string, handle: TerminalInstanceHandle | null) => void
  /** Close a single pane (kills that session; the group survives). */
  onClosePane: (sessionId: string) => void
  className?: string
}

export function TerminalPaneGroup({
  anchorId,
  onFocusedChange,
  onClosePane,
  className,
}: TerminalPaneGroupProps) {
  const t = useTranslations("terminal.dock")
  const splitPanes = useTerminalStore((s) => s.splitPanes)
  const focusedByAnchor = useTerminalStore((s) => s.focusedPaneByAnchor)
  const splitDirection = useTerminalStore((s) => s.splitDirection)
  const setFocusedPane = useTerminalStore((s) => s.setFocusedPane)

  const panes = useMemo(() => [anchorId, ...(splitPanes[anchorId] ?? [])], [anchorId, splitPanes])
  const storedFocus = focusedByAnchor[anchorId]
  const focused = storedFocus && panes.includes(storedFocus) ? storedFocus : anchorId
  const orientation = (splitDirection[anchorId] ?? "row") === "col" ? "vertical" : "horizontal"

  const handlesRef = useRef(new Map<string, TerminalInstanceHandle | null>())
  const layout = useResizableLayout(`cognia-terminal-panes-${anchorId}`)

  // Surface the focused pane (+ its handle) to the dock. Child instance
  // refs are attached before this parent effect runs, so the handle is
  // populated by the time we read it.
  useEffect(() => {
    onFocusedChange(focused, handlesRef.current.get(focused) ?? null)
  }, [focused, panes, onFocusedChange])

  const focus = useCallback(
    (id: string) => {
      if (id !== focused) setFocusedPane(anchorId, id)
    },
    [anchorId, focused, setFocusedPane]
  )

  const setHandle = useCallback(
    (id: string, handle: TerminalInstanceHandle | null) => {
      handlesRef.current.set(id, handle)
      // If the handle for the currently-focused pane just became available
      // (async xterm mount), re-report so the dock's ref is fresh.
      if (id === focused) onFocusedChange(focused, handle)
    },
    [focused, onFocusedChange]
  )

  if (panes.length === 1) {
    return (
      <div
        className={cn("h-full w-full", className)}
        data-testid="terminal-pane-group"
        data-panes="1"
      >
        <PaneBox
          sessionId={anchorId}
          focused
          single
          onFocus={() => focus(anchorId)}
          onClose={() => onClosePane(anchorId)}
          setHandle={setHandle}
          closeLabel={t("closePane")}
        />
      </div>
    )
  }

  return (
    <ResizablePanelGroup
      orientation={orientation}
      className={cn("h-full w-full", className)}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      data-testid="terminal-pane-group"
      data-panes={String(panes.length)}
    >
      {panes.map((id, idx) => (
        <Fragment key={id}>
          {idx > 0 ? <ResizableHandle /> : null}
          <ResizablePanel id={id} defaultSize={100 / panes.length} minSize={10}>
            <PaneBox
              sessionId={id}
              focused={id === focused}
              single={false}
              onFocus={() => focus(id)}
              onClose={() => onClosePane(id)}
              setHandle={setHandle}
              closeLabel={t("closePane")}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

function PaneBox({
  sessionId,
  focused,
  single,
  onFocus,
  onClose,
  setHandle,
  closeLabel,
}: {
  sessionId: string
  focused: boolean
  single: boolean
  onFocus: () => void
  onClose: () => void
  setHandle: (id: string, handle: TerminalInstanceHandle | null) => void
  closeLabel: string
}) {
  return (
    <div
      className={cn(
        "relative h-full w-full",
        !single && focused && "ring-1 ring-inset ring-primary/60"
      )}
      data-testid="terminal-pane"
      data-session-id={sessionId}
      data-focused={focused ? "true" : "false"}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <TerminalInstance ref={(h) => setHandle(sessionId, h)} sessionId={sessionId} />
      {!single ? (
        <Button
          size="icon"
          variant="ghost"
          className="absolute right-1 top-1 z-10 h-5 w-5 opacity-0 hover:opacity-100 focus-visible:opacity-100"
          onClick={onClose}
          aria-label={closeLabel}
          data-testid="terminal-pane-close"
        >
          <XIcon className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  )
}

export default TerminalPaneGroup
