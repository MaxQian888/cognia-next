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
      className="flex h-full w-full flex-col border-t bg-background"
      data-testid="terminal-dock"
      data-project-id={activeProjectId ?? "none"}
    >
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
