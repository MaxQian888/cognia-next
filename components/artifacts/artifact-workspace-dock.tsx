"use client"

/**
 * ArtifactWorkspaceDock — wraps the chat workspace so a docked, resizable
 * artifacts panel can sit in the right rail on desktop. On tablet/mobile it
 * renders the children plus Artifact and Workspace Sheet fallbacks. Both
 * sheets reuse the same content components as their desktop dock surfaces.
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
import { motion } from "motion/react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useBreakpoint } from "@/hooks/ui"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  ARTIFACT_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDockShortcuts } from "@/hooks/artifacts/use-artifact-dock-shortcuts"
import { useGitBranchIndicator } from "@/hooks/git/use-git-branch-indicator"
import { ArtifactPanel } from "./artifact-panel"
import { ArtifactDock } from "./artifact-dock"
import { MobileWorkspaceSheet } from "./workspace-mode/mobile-workspace-sheet"
import { WorkspaceRevealOpener } from "./workspace-mode/workspace-reveal-opener"

const CHAT_MIN = "50%"

export function ArtifactWorkspaceDock({ children }: { children: ReactNode }) {
  useArtifactDockShortcuts()
  const breakpoint = useBreakpoint()

  if (breakpoint !== "desktop") {
    return <ArtifactWorkspaceDockNarrow>{children}</ArtifactWorkspaceDockNarrow>
  }

  return <ArtifactWorkspaceDockDesktop>{children}</ArtifactWorkspaceDockDesktop>
}

function ArtifactWorkspaceDockNarrow({ children }: { children: ReactNode }) {
  // DesktopAppShell's StatusBar remains the sole native watcher owner even
  // when a Tauri window narrows. Paired web/mobile has no StatusBar, so this
  // narrow host owns the Companion-side binding/subscription there.
  useGitBranchIndicator({ enabled: !isTauri() })
  const dockMode = useArtifactDockLayoutStore((state) => state.dockMode)
  const mobileSheetOpen = useArtifactDockLayoutStore((state) => state.mobileSheetOpen)
  const setDockMode = useArtifactDockLayoutStore((state) => state.setDockMode)
  const setMobileSheetOpen = useArtifactDockLayoutStore((state) => state.setMobileSheetOpen)
  const panelOpen = useArtifactStore((state) => state.panelOpen)
  const panelView = useArtifactStore((state) => state.panelView)
  const closePanel = useArtifactStore((state) => state.closePanel)
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const previousArtifactId = useRef(activeArtifactId)

  useEffect(() => {
    if (dockMode === "workspace" && mobileSheetOpen && panelOpen && panelView === "artifact") {
      closePanel()
    }
  }, [closePanel, dockMode, mobileSheetOpen, panelOpen, panelView])

  useEffect(() => {
    const previous = previousArtifactId.current
    previousArtifactId.current = activeArtifactId
    if (activeArtifactId && activeArtifactId !== previous) {
      setDockMode("artifact")
      setMobileSheetOpen(false)
    }
  }, [activeArtifactId, setDockMode, setMobileSheetOpen])

  return (
    <div data-testid="artifact-workspace-dock-mobile" className="flex min-h-0 flex-1 flex-col">
      <WorkspaceRevealOpener />
      {children}
      <ArtifactPanel />
      <MobileWorkspaceSheet />
    </div>
  )
}

function ArtifactWorkspaceDockDesktop({ children }: { children: ReactNode }) {
  const dockSize = useArtifactDockLayoutStore((s) => s.dockSize)
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const layoutVersion = useArtifactDockLayoutStore((s) => s.layoutVersion)
  const setDockSize = useArtifactDockLayoutStore((s) => s.setDockSize)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const setDockMode = useArtifactDockLayoutStore((s) => s.setDockMode)

  // Auto-expand the dock when a fresh artifact becomes active. Keyed on the id
  // so re-collapsing while the same artifact stays active is respected (we only
  // expand on a *new* artifact, not on every render).
  const activeArtifactId = useArtifactStore((s) => s.activeArtifactId)
  const prevActiveIdRef = useRef<string | null>(activeArtifactId)
  useEffect(() => {
    const prev = prevActiveIdRef.current
    prevActiveIdRef.current = activeArtifactId
    if (activeArtifactId && activeArtifactId !== prev) {
      setDockMode("artifact")
      setDockCollapsed(false)
    }
  }, [activeArtifactId, setDockCollapsed, setDockMode])

  const collapseTransition = useReducedMotionTransition(mobileTransition("normal"))

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
        <ResizablePanel id="artifact-chat" minSize={CHAT_MIN}>
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
        </ResizablePanel>

        <ResizableHandle withHandle className={cn(dockCollapsed && "hidden")} />

        <ResizablePanel
          id="artifact-dock"
          defaultSize={dockCollapsed ? "0%" : `${dockSize}%`}
          minSize={dockCollapsed ? "0%" : `${ARTIFACT_DOCK_BOUNDS.min}%`}
          maxSize={`${ARTIFACT_DOCK_BOUNDS.max}%`}
          collapsible
          collapsedSize="0%"
        >
          <motion.div
            data-testid="artifact-dock-wrapper"
            layout
            animate={{ opacity: dockCollapsed ? 0 : 1 }}
            transition={collapseTransition}
            className="h-full min-w-0 overflow-hidden"
          >
            <ArtifactDock />
          </motion.div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default ArtifactWorkspaceDock
