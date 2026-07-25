"use client"

/**
 * ArtifactWorkspaceDock — wraps the chat workspace so a docked, resizable
 * artifacts panel can sit in the right rail on desktop. On tablet/mobile it
 * renders the children plus a single workbench Sheet fallback, which hosts the
 * same panels — and the same resources — as the desktop dock.
 *
 * Desktop layout (Codex / Claude-artifacts style):
 *   ┌───────────────────────────┬──────────────┐
 *   │ Chat (children)           │ Artifacts    │
 *   │            ◀ resize ▶     │ dock         │
 *   └───────────────────────────┴──────────────┘
 *
 * The dock auto-expands when a new artifact becomes active, collapses to 0
 * width otherwise, and its size survives reloads via `useArtifactDockLayoutStore`.
 * Cmd/Ctrl+J toggles it (see `useArtifactDockShortcuts`).
 */

import { useEffect, useRef, type ReactNode } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"
import { cn } from "@/lib/utils"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  ARTIFACT_DOCK_BOUNDS,
  CHAT_MIN_PERCENT,
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDockShortcuts } from "@/hooks/artifacts/use-artifact-dock-shortcuts"
import { ArtifactPanel } from "./artifact-panel"
import { ArtifactDock } from "./artifact-dock"
import { WorkspaceRevealOpener } from "./workspace-mode/workspace-reveal-opener"

/**
 * Apply a dock size change under a short flex-grow transition, then strip the
 * transition again so manual divider dragging stays immediate.
 *
 * The panel's content is pinned to the width it will occupy when the animation
 * settles, so the shrinking shell *wipes* it instead of reflowing it. Without
 * that pin the dock squashed for 200ms — the activity rail is `shrink-0` while
 * the panel body is not, so the body alone got crushed on the way out and
 * stretched on the way in.
 *
 * Uses inline styles (not Tailwind classes) so the duration can consume the
 * user's `--motion-duration-scale` preference — a runtime `classList.add` of an
 * arbitrary Tailwind class would never be JIT-compiled into the CSS. The
 * cleanup delay is scaled by the same multiplier so a slower (1.5×) preference
 * isn't cut short; reduce-motion collapses it via the global CSS guard.
 *
 * **Skipped entirely while a Pro IDE pane is pinned inside this dock.** That
 * pane is a native child webview floating above the DOM: CSS neither clips nor
 * tweens it, and its bounds are re-pushed over IPC once per frame. Animating
 * around it costs a full VS Code relayout every frame — and, worse, the frozen
 * content width below would hold the reserved rect at full size for the whole
 * 200ms, so a collapse left a full-width VS Code hanging over the chat before
 * snapping away. `app/globals.css` states this policy for the shell transitions
 * it can reach; inline styles are out of the stylesheet's reach, so the same
 * policy is enforced here instead.
 */
function animateDockResize(
  panel: HTMLDivElement,
  content: HTMLDivElement | null,
  /** Target width as a percent of the group, or null when collapsing to zero. */
  targetPercent: number | null,
  apply: () => void
): () => void {
  if (isProIdePanePinnedWithin(panel)) {
    apply()
    return () => {}
  }

  // Collapsing: hold what is on screen. Expanding: the panel is at ~0, so hold
  // the width it is heading for — the content is then laid out correctly from
  // the first frame and the widening panel reveals it.
  const frozenWidth =
    targetPercent === null
      ? (content?.offsetWidth ?? 0)
      : ((panel.parentElement?.offsetWidth ?? 0) * targetPercent) / 100

  const reset = () => {
    panel.style.transitionProperty = ""
    panel.style.transitionDuration = ""
    panel.style.transitionTimingFunction = ""
    if (content) content.style.width = ""
  }

  if (content && frozenWidth > 0) content.style.width = `${frozenWidth}px`
  panel.style.transitionProperty = "flex-grow"
  panel.style.transitionDuration = "calc(200ms * var(--motion-duration-scale, 1))"
  panel.style.transitionTimingFunction = "ease-in-out"
  // Commit the transition style before react-resizable-panels updates flex-grow.
  void panel.offsetWidth
  apply()

  const scale = Number(getComputedStyle(panel).getPropertyValue("--motion-duration-scale")) || 1
  const timer = window.setTimeout(reset, 200 * scale + 40)
  return () => {
    window.clearTimeout(timer)
    reset()
  }
}

export function ArtifactWorkspaceDock({ children }: { children: ReactNode }) {
  useArtifactDockShortcuts()
  const breakpoint = useBreakpoint()

  if (breakpoint !== "desktop") {
    return <ArtifactWorkspaceDockNarrow>{children}</ArtifactWorkspaceDockNarrow>
  }

  return <ArtifactWorkspaceDockDesktop>{children}</ArtifactWorkspaceDockDesktop>
}

function ArtifactWorkspaceDockNarrow({ children }: { children: ReactNode }) {
  const mobileSheetOpen = useArtifactDockLayoutStore((state) => state.mobileSheetOpen)
  const setMobileSheetOpen = useArtifactDockLayoutStore((state) => state.setMobileSheetOpen)
  const panelOpen = useArtifactStore((state) => state.panelOpen)
  const openPanel = useArtifactStore((state) => state.openPanel)

  // A reveal from outside (terminal link, Edit/Write review, the browser
  // button) asks for the Sheet by raising `mobileSheetOpen`. There is now a
  // single Sheet to raise, so that request simply opens the artifact panel —
  // the two-Sheet mutual-exclusion dance this replaced is gone.
  useEffect(() => {
    if (mobileSheetOpen && !panelOpen) openPanel("artifact")
  }, [mobileSheetOpen, openPanel, panelOpen])

  useEffect(() => {
    if (!panelOpen && mobileSheetOpen) setMobileSheetOpen(false)
  }, [mobileSheetOpen, panelOpen, setMobileSheetOpen])

  return (
    <div data-testid="artifact-workspace-dock-mobile" className="flex min-h-0 flex-1 flex-col">
      <WorkspaceRevealOpener />
      {children}
      <ArtifactPanel />
    </div>
  )
}

function ArtifactWorkspaceDockDesktop({ children }: { children: ReactNode }) {
  const dockSize = useArtifactDockLayoutStore((s) => s.dockSize)
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const dockProfile = useArtifactDockLayoutStore((s) => s.dockProfile)
  const layoutVersion = useArtifactDockLayoutStore((s) => s.layoutVersion)
  const dockSizeRequest = useArtifactDockLayoutStore((s) => s.dockSizeRequest)
  const setDockSize = useArtifactDockLayoutStore((s) => s.setDockSize)
  const requestDockSize = useArtifactDockLayoutStore((s) => s.requestDockSize)
  const notifyNewArtifact = useArtifactDockLayoutStore((s) => s.notifyNewArtifact)
  const dockPanelRef = useRef<PanelImperativeHandle | null>(null)
  const dockPanelElementRef = useRef<HTMLDivElement | null>(null)
  const dockContentElementRef = useRef<HTMLDivElement | null>(null)
  const previousDockCollapsedRef = useRef(dockCollapsed)
  const previousDockSizeRequestRef = useRef(dockSizeRequest)

  // Match the conversation sidebar: animate only collapse/expand for ~200ms,
  // then remove the transition so manual divider dragging remains immediate.
  useEffect(() => {
    if (previousDockCollapsedRef.current === dockCollapsed) return
    previousDockCollapsedRef.current = dockCollapsed

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element) return

    return animateDockResize(
      element,
      dockContentElementRef.current,
      dockCollapsed ? null : dockSize,
      () => {
        if (dockCollapsed) panel.collapse()
        else panel.resize(`${dockSize}%`)
      }
    )
  }, [dockCollapsed, dockSize])

  // A width preset (the workbench narrow/wide buttons) asked for a specific
  // size. Keyed on the request token rather than `dockSize`, because a drag
  // rewrites `dockSize` on every tick and would otherwise re-enter here and
  // fight the pointer.
  useEffect(() => {
    if (previousDockSizeRequestRef.current === dockSizeRequest) return
    previousDockSizeRequestRef.current = dockSizeRequest

    const panel = dockPanelRef.current
    const element = dockPanelElementRef.current
    if (!panel || !element || dockCollapsed) return

    return animateDockResize(element, dockContentElementRef.current, dockSize, () =>
      panel.resize(`${dockSize}%`)
    )
  }, [dockCollapsed, dockSize, dockSizeRequest])

  // Auto-expand the dock when a fresh artifact becomes active — unless the user
  // manually dismissed it, in which case `notifyNewArtifact` only flags it
  // unread (a dot on the chat-header toggle) instead of yanking it open. Keyed
  // on the id so it only reacts to a *new* artifact, not every render.
  const activeArtifactId = useArtifactStore((s) => s.activeArtifactId)
  const prevActiveIdRef = useRef<string | null>(activeArtifactId)
  useEffect(() => {
    const prev = prevActiveIdRef.current
    prevActiveIdRef.current = activeArtifactId
    if (activeArtifactId && activeArtifactId !== prev) {
      notifyNewArtifact()
    }
  }, [activeArtifactId, notifyNewArtifact])

  const workspaceProfile = dockProfile === "workspace"
  const chatMinSize = workspaceProfile
    ? `${CHAT_MIN_PERCENT.workspace}%`
    : `${CHAT_MIN_PERCENT.default}%`
  const dockMinSize = workspaceProfile
    ? WORKSPACE_DOCK_BOUNDS.minPx
    : `${ARTIFACT_DOCK_BOUNDS.min}%`
  const dockMaxSize = workspaceProfile
    ? `${WORKSPACE_DOCK_BOUNDS.max}%`
    : `${ARTIFACT_DOCK_BOUNDS.max}%`

  return (
    <div
      className="flex w-full flex-1 min-h-0 overflow-hidden"
      data-testid="artifact-workspace-dock"
    >
      <WorkspaceRevealOpener />
      <ResizablePanelGroup
        key={layoutVersion}
        orientation="horizontal"
        className="flex-1 min-h-0"
        onLayoutChanged={(layout) => {
          const dock = layout["artifact-dock"]
          if (!dockCollapsed && typeof dock === "number" && dock >= ARTIFACT_DOCK_BOUNDS.min) {
            setDockSize(dock)
          }
        }}
      >
        <ResizablePanel id="artifact-chat" minSize={chatMinSize}>
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
        </ResizablePanel>

        {/* Fades and narrows in lockstep with the panel. A hard `hidden` made
            the divider pop in over a zero-width dock on expand, and vanish
            before the dock had finished retracting on collapse. */}
        <ResizableHandle
          withHandle
          aria-hidden={dockCollapsed || undefined}
          className={cn(
            "transition-[width,opacity] duration-[calc(200ms*var(--motion-duration-scale,1))] ease-in-out",
            dockCollapsed && "w-0 opacity-0 [&>div]:opacity-0"
          )}
          disabled={dockCollapsed}
          // Editor-splitter convention: double-click restores the current
          // profile's preset width. Routed through the request token so the
          // change animates like the narrow/wide buttons instead of snapping.
          onDoubleClick={() => {
            if (dockCollapsed) return
            requestDockSize(DOCK_MODE_WIDTH_PERCENT[dockProfile].narrow)
          }}
        />

        <ResizablePanel
          id="artifact-dock"
          panelRef={dockPanelRef}
          elementRef={dockPanelElementRef}
          defaultSize={dockCollapsed ? "0%" : `${dockSize}%`}
          minSize={dockMinSize}
          maxSize={dockMaxSize}
          collapsible
          collapsedSize="0%"
        >
          <div
            ref={dockContentElementRef}
            data-testid="artifact-dock-wrapper"
            className="h-full min-w-0 overflow-hidden"
          >
            <ArtifactDock />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default ArtifactWorkspaceDock
