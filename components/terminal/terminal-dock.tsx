"use client"

/**
 * Bottom-docked integrated terminal panel.
 *
 * Composition:
 *   * Header: tabs (one per session in the active project) + "+ New" +
 *     close-panel button. Tab click selects; tab × kills; right-click
 *     opens the context menu (rename / restart / close / close others /
 *     trust agent).
 *   * Body: `<TerminalInstance>` for the active session, plus a floating
 *     `<TerminalSearchOverlay>` toggled by Ctrl+F. Or
 *     `<TerminalEmptyState>` when none.
 *
 * Filters tabs by `activeProjectId` from `useProjectStore`; switching
 * projects hides — but does NOT kill — the previous project's tabs.
 * Visibility is purely a render-time filter on the store snapshot.
 *
 * Mounted inside `components/desktop/desktop-app-shell.tsx` (task #11),
 * which wraps the page in a vertical `ResizablePanelGroup` and gates
 * mount behind `isTauri()`.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { killFromDock, restartFromDock, spawnFromDock } from "@/lib/terminal/spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

import { TerminalEmptyState } from "./terminal-empty-state"
import { TerminalHistoryPanel } from "./terminal-history-panel"
import { TerminalInstance, type TerminalInstanceHandle } from "./terminal-instance"
import { TerminalSearchOverlay } from "./terminal-search-overlay"
import { TerminalTabContextMenu } from "./terminal-tab-context-menu"
import { TerminalTabStrip } from "./terminal-tab-strip"

export function TerminalDock() {
  const t = useTranslations("terminal.dock")
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const setPanelOpen = useTerminalStore((s) => s.setPanelOpen)
  const sessions = useTerminalStore((s) => s.sessions)
  const activeByProject = useTerminalStore((s) => s.activeSessionIdByProject)
  const setActiveSession = useTerminalStore((s) => s.setActiveSession)
  const renameSession = useTerminalStore((s) => s.renameSession)
  const setAgentTrusted = useTerminalStore((s) => s.setAgentTrusted)

  const setPanelHeight = useTerminalStore((s) => s.setPanelHeight)

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const project = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )

  const settingsTerminalShell = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultShell?: string } | undefined)?.defaultShell
  )

  const projectKey = activeProjectId ?? ""
  const tabs = useMemo<TerminalSessionRow[]>(() => {
    return Object.values(sessions)
      .filter((row) => (row.projectId ?? "") === projectKey)
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [sessions, projectKey])

  const activeId = activeByProject[projectKey] ?? null
  const activeRow = activeId ? sessions[activeId] : undefined

  const instanceRef = useRef<TerminalInstanceHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)

  const handleNew = useCallback(async () => {
    const shell = resolveDefaultShell({
      projectShell: project?.terminalConfig?.shell,
      settingShell: settingsTerminalShell,
    })
    const cwd = project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined
    const env = project?.terminalConfig?.env
    await spawnFromDock({
      req: {
        shell,
        rows: 24,
        cols: 80,
        cwd,
        env,
        projectId: activeProjectId ?? undefined,
        enableShellIntegration: true,
      },
      store: useTerminalStore.getState(),
    })
  }, [project, activeProjectId, settingsTerminalShell])

  const handleClose = useCallback((id: string) => {
    void killFromDock(id, useTerminalStore.getState())
  }, [])

  const handleSelect = useCallback(
    (id: string) => {
      setActiveSession(activeProjectId, id)
    },
    [activeProjectId, setActiveSession]
  )

  const handleRestart = useCallback((id: string) => {
    const term = instanceRef.current
    const rows = 24
    const cols = 80
    void restartFromDock({
      sessionId: id,
      store: useTerminalStore.getState(),
      rows,
      cols,
    })
    // term ref is exposed for future spatial-aware respawn; not used here.
    void term
  }, [])

  const handleCloseOthers = useCallback(
    (id: string) => {
      const state = useTerminalStore.getState()
      const others = state.sessionsForProject(activeProjectId).filter((row) => row.id !== id)
      for (const row of others) {
        void killFromDock(row.id, state)
      }
    },
    [activeProjectId]
  )

  const handleToggleTrust = useCallback(
    (id: string, trusted: boolean) => {
      setAgentTrusted(id, trusted)
    },
    [setAgentTrusted]
  )

  const handleRename = useCallback((id: string) => {
    setRenameTarget(id)
  }, [])

  const commitRename = useCallback(
    (id: string, value: string | null) => {
      renameSession(id, value)
      setRenameTarget(null)
    },
    [renameSession]
  )

  if (!panelOpen) return null

  const transport = selectTerminalTransport()
  const emptyVariant: "desktop" | "mobile" | "unsupported" =
    transport === "tauri-channel" ? "desktop" : transport === "ws" ? "mobile" : "unsupported"

  // Wrap each rendered tab in its own context-menu trigger by hooking the
  // strip's onContextMenu — but the menu needs to render *inline* per tab
  // so Radix's portal anchors correctly. We re-render the strip with the
  // contextual menu wrapper applied to each TerminalTab.
  // (TerminalTabStrip already iterates and renders TerminalTab; we use the
  // onContextMenu callback to position the menu via DOM.)
  // For simplicity v1 wires the menu as a per-tab wrapper via the strip's
  // built-in onContextMenu prop AND a separate render layer.

  return (
    <div
      className="relative flex h-full w-full flex-col border-t bg-background"
      data-testid="terminal-dock"
      data-project-id={activeProjectId ?? "none"}
    >
      {/* Wave 4 — drag-resize handle. Pinned to the top edge so
          dragging up grows the dock at the expense of the editor
          area above. Keyboard-accessible via arrow keys when
          focused (the focus ring shows up via focus-visible:bg). */}
      <div
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-label={t("resize")}
        data-testid="terminal-dock-resize-handle"
        className="absolute -top-0.5 left-0 right-0 z-10 h-1 cursor-row-resize bg-transparent hover:bg-primary/50 focus-visible:bg-primary focus-visible:outline-none"
        onPointerDown={(e) => beginResize(e, setPanelHeight)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault()
            adjustPanelHeight(useTerminalStore.getState().panelHeightPct, -2, setPanelHeight)
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            adjustPanelHeight(useTerminalStore.getState().panelHeightPct, 2, setPanelHeight)
          }
        }}
      />
      <TerminalTabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={handleSelect}
        onClose={handleClose}
        testId="terminal-dock-tabs"
        trailing={
          <>
            {transport === "tauri-channel" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void handleNew()
                }}
                aria-label={t("newSession")}
                data-testid="terminal-dock-new"
                className="h-7 px-2 text-xs"
              >
                <PlusIcon className="mr-1 h-3 w-3" />
                {t("newSession")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanelOpen(false)}
              aria-label={t("closePanel")}
              data-testid="terminal-dock-close"
              className="h-7 w-7 p-0"
            >
              <XIcon className="h-3 w-3" />
            </Button>
          </>
        }
      />
      <div className="relative flex-1 overflow-hidden">
        {activeRow ? (
          <>
            {/* Context-menu wrapper for the active tab — covers the
                instance area so right-click on the terminal also offers
                tab-level actions. */}
            <TerminalTabContextMenu
              row={activeRow}
              onRename={handleRename}
              onRestart={handleRestart}
              onClose={handleClose}
              onCloseOthers={handleCloseOthers}
              onToggleAgentTrust={handleToggleTrust}
            >
              <div
                className="h-full w-full"
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                    e.preventDefault()
                    setSearchOpen(true)
                  }
                }}
              >
                <TerminalInstance ref={instanceRef} sessionId={activeRow.id} />
              </div>
            </TerminalTabContextMenu>
            <TerminalSearchOverlay
              open={searchOpen}
              onClose={() => setSearchOpen(false)}
              instanceRef={instanceRef}
            />
            <TerminalHistoryPanel sessionId={activeRow.id} />
            {renameTarget === activeRow.id ? (
              <DockRenameOverlay
                row={activeRow}
                onCommit={(v) => commitRename(activeRow.id, v)}
                onCancel={() => setRenameTarget(null)}
              />
            ) : null}
          </>
        ) : (
          <TerminalEmptyState variant={emptyVariant} onNew={handleNew} />
        )}
      </div>
    </div>
  )
}

/**
 * Tiny inline rename input rendered as an overlay on the active tab area.
 * Pattern transplanted from `components/desktop/session-row.tsx`. Enter
 * commits; Escape cancels; empty value clears the custom title.
 */
function DockRenameOverlay({
  row,
  onCommit,
  onCancel,
}: {
  row: TerminalSessionRow
  onCommit: (value: string | null) => void
  onCancel: () => void
}) {
  const t = useTranslations("terminal.tab.rename")
  const [draft, setDraft] = useState(row.customTitle ?? row.title)
  return (
    <div
      role="dialog"
      data-testid="terminal-dock-rename"
      aria-label={t("label")}
      className="absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 shadow"
    >
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            onCommit(draft.length > 0 ? draft : null)
          } else if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => onCommit(draft.length > 0 ? draft : null)}
        className="h-7 w-56 rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
        placeholder={t("placeholder")}
        aria-label={t("inputLabel")}
        data-testid="terminal-dock-rename-input"
      />
    </div>
  )
}

export default TerminalDock

/**
 * Begin a pointer-drag resize of the dock height. Captures pointer move
 * events on the window so the cursor doesn't have to stay glued to the
 * handle; clamps to TERMINAL_LAYOUT_BOUNDS via the store.
 *
 * The handle sits at the TOP of the dock — dragging up grows it, down
 * shrinks it. We translate the deltaY into a pct of the viewport so the
 * stored value survives a resize / different display.
 */
function beginResize(
  startEvent: React.PointerEvent<HTMLDivElement>,
  setPanelHeight: (pct: number) => void
): void {
  startEvent.preventDefault()
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800
  if (viewportH <= 0) return
  const startY = startEvent.clientY
  const startPct = useTerminalStore.getState().panelHeightPct
  let lastPct = startPct

  function onMove(e: PointerEvent) {
    const deltaY = e.clientY - startY
    const deltaPct = (deltaY / viewportH) * 100
    // Drag up (negative deltaY) → bigger panel. Subtract so the dock
    // grows toward the cursor.
    const next = startPct - deltaPct
    if (Math.abs(next - lastPct) < 0.25) return
    lastPct = next
    setPanelHeight(next)
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onUp)
  }
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
  window.addEventListener("pointercancel", onUp)
}

/** Keyboard-driven height adjustment for the resize separator (2% per press). */
function adjustPanelHeight(
  currentPct: number,
  delta: number,
  setPanelHeight: (pct: number) => void
): void {
  setPanelHeight(currentPct + delta)
}
