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
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { findProfile, profileToSpawnFields, type TerminalProfile } from "@/lib/terminal/profiles"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import { killFromDock, restartFromDock, spawnFromDock } from "@/lib/terminal/spawn-orchestrator"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

import { FileViewerDialog } from "./file-viewer-dialog"
import { TerminalEmptyState } from "./terminal-empty-state"
import { TerminalHistoryPanel } from "./terminal-history-panel"
import { type TerminalInstanceHandle } from "./terminal-instance"
import { TerminalPaneGroup } from "./terminal-pane-group"
import { TerminalSearchOverlay } from "./terminal-search-overlay"
import { TerminalShellPicker } from "./terminal-shell-picker"
import { TerminalTabContextMenu } from "./terminal-tab-context-menu"
import { TerminalTabStrip } from "./terminal-tab-strip"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

export function TerminalDock() {
  const t = useTranslations("terminal.dock")
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const setPanelOpen = useTerminalStore((s) => s.setPanelOpen)
  const sessions = useTerminalStore((s) => s.sessions)
  const activeByProject = useTerminalStore((s) => s.activeSessionIdByProject)
  const splitPanes = useTerminalStore((s) => s.splitPanes)
  const setActiveSession = useTerminalStore((s) => s.setActiveSession)
  const renameSession = useTerminalStore((s) => s.renameSession)
  const setAgentTrusted = useTerminalStore((s) => s.setAgentTrusted)
  const addPaneToGroup = useTerminalStore((s) => s.addPaneToGroup)

  const setPanelHeight = useTerminalStore((s) => s.setPanelHeight)

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const project = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )

  const settingsTerminalShell = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultShell?: string } | undefined)?.defaultShell
  )
  const settingsForceUtf8 = useSettingsStore(
    (s) => (s.settings?.terminal as { forceUtf8?: boolean } | undefined)?.forceUtf8 ?? true
  )
  // ADR-0028 Phase 3 (P4.1) — opt-in sandboxed terminal. Off by default.
  const settingsSandboxed = useSettingsStore(
    (s) => (s.settings?.terminal as { sandboxed?: boolean } | undefined)?.sandboxed ?? false
  )
  const settingsProfiles = useSettingsStore(
    (s) => (s.settings?.terminal as { profiles?: TerminalProfile[] } | undefined)?.profiles
  )
  const settingsDefaultProfileId = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultProfileId?: string } | undefined)?.defaultProfileId
  )

  const projectKey = activeProjectId ?? ""
  const tabs = useMemo<TerminalSessionRow[]>(() => {
    // Tab strip lists group anchors only — split-pane members are hidden
    // (they render inside their anchor's TerminalPaneGroup).
    const isGroupMember = (id: string) =>
      Object.values(splitPanes).some((members) => members.includes(id))
    return Object.values(sessions)
      .filter((row) => (row.projectId ?? "") === projectKey)
      .filter((row) => !isGroupMember(row.id))
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [sessions, splitPanes, projectKey])

  const activeId = activeByProject[projectKey] ?? null
  const activeRow = activeId ? sessions[activeId] : undefined

  // The pane group reports which pane is focused; the search overlay,
  // history rail and command-jump keys all target that pane.
  const focusedHandleRef = useRef<TerminalInstanceHandle | null>(null)
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null)
  const onFocusedChange = useCallback(
    (sessionId: string, handle: TerminalInstanceHandle | null) => {
      focusedHandleRef.current = handle
      setFocusedSessionId(sessionId)
    },
    []
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)

  // Spawn + surface failures. Without this, an `error`/`denied` outcome was
  // dropped silently — the user clicked "+ New" and nothing happened, no
  // toast. Now every spawn path reports why it failed (incl. the spawn
  // timeout that guards against a wedged backend).
  const spawnWithFeedback = useCallback(
    async (input: Parameters<typeof spawnFromDock>[0]) => {
      const outcome = await spawnFromDock(input)
      if (outcome.kind === "error") {
        toast.error(t("spawnError", { message: outcome.message }))
      } else if (outcome.kind === "denied") {
        toast.error(t("spawnDenied"))
      }
      return outcome
    },
    [t]
  )

  const handleNewWithShell = useCallback(
    async (shellOverride?: string) => {
      // An explicit override (from the new-tab shell picker) wins over the
      // resolved default; otherwise fall back to project / settings / platform.
      const shell =
        shellOverride && shellOverride.trim().length > 0
          ? shellOverride
          : resolveDefaultShell({
              projectShell: project?.terminalConfig?.shell,
              settingShell: settingsTerminalShell,
            })
      const cwd = project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined
      const env = project?.terminalConfig?.env
      await spawnWithFeedback({
        req: {
          shell,
          rows: 24,
          cols: 80,
          cwd,
          env,
          projectId: activeProjectId ?? undefined,
          enableShellIntegration: true,
          forceUtf8: settingsForceUtf8,
          sandboxed: settingsSandboxed,
        },
        store: useTerminalStore.getState(),
      })
    },
    [
      project,
      activeProjectId,
      settingsTerminalShell,
      settingsForceUtf8,
      settingsSandboxed,
      spawnWithFeedback,
    ]
  )

  const handleNewFromProfile = useCallback(
    async (profileId: string) => {
      const profile = findProfile(settingsProfiles, profileId)
      const fields = profile ? profileToSpawnFields(profile) : null
      if (!fields) {
        // Profile gone or shell blank — fall back to the resolved default.
        await handleNewWithShell()
        return
      }
      await spawnWithFeedback({
        req: {
          ...fields,
          rows: 24,
          cols: 80,
          projectId: activeProjectId ?? undefined,
          enableShellIntegration: true,
          forceUtf8: settingsForceUtf8,
          sandboxed: settingsSandboxed,
        },
        store: useTerminalStore.getState(),
      })
    },
    [
      settingsProfiles,
      activeProjectId,
      settingsForceUtf8,
      settingsSandboxed,
      handleNewWithShell,
      spawnWithFeedback,
    ]
  )

  // Plain "+ New": launch the default profile when one is set, else resolve
  // the default shell (project → settings → platform).
  const handleNew = useCallback(() => {
    if (settingsDefaultProfileId && findProfile(settingsProfiles, settingsDefaultProfileId)) {
      void handleNewFromProfile(settingsDefaultProfileId)
    } else {
      void handleNewWithShell()
    }
  }, [settingsDefaultProfileId, settingsProfiles, handleNewFromProfile, handleNewWithShell])

  // Close a single split pane — kills just that session; the group's
  // other panes (and the tab) survive via the store's anchor-promotion.
  const handleClosePane = useCallback((id: string) => {
    void killFromDock(id, useTerminalStore.getState())
  }, [])

  // Close a whole tab — kills every pane in the group.
  const handleCloseTab = useCallback((anchorId: string) => {
    const state = useTerminalStore.getState()
    for (const paneId of state.panesForGroup(anchorId)) {
      void killFromDock(paneId, state)
    }
  }, [])

  const handleSelect = useCallback(
    (id: string) => {
      setActiveSession(activeProjectId, id)
    },
    [activeProjectId, setActiveSession]
  )

  const handleRestart = useCallback((id: string) => {
    void restartFromDock({
      sessionId: id,
      store: useTerminalStore.getState(),
      rows: 24,
      cols: 80,
    })
  }, [])

  const handleCloseOthers = useCallback(
    (anchorId: string) => {
      const state = useTerminalStore.getState()
      const others = state.tabsForProject(activeProjectId).filter((row) => row.id !== anchorId)
      for (const row of others) {
        for (const paneId of state.panesForGroup(row.id)) {
          void killFromDock(paneId, state)
        }
      }
    },
    [activeProjectId]
  )

  // Split the active tab: spawn a fresh session and attach it to the
  // active group as a pane. `direction` "row" = side-by-side, "col" =
  // stacked (mirrors the whole group's orientation).
  const handleSplit = useCallback(
    async (direction: "row" | "col") => {
      const state = useTerminalStore.getState()
      const anchor = state.activeSessionIdByProject[projectKey] ?? null
      if (!anchor) return
      const shell = resolveDefaultShell({
        projectShell: project?.terminalConfig?.shell,
        settingShell: settingsTerminalShell,
      })
      const cwd = project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined
      const outcome = await spawnWithFeedback({
        req: {
          shell,
          rows: 24,
          cols: 80,
          cwd,
          env: project?.terminalConfig?.env,
          projectId: activeProjectId ?? undefined,
          enableShellIntegration: true,
          forceUtf8: settingsForceUtf8,
          sandboxed: settingsSandboxed,
        },
        store: useTerminalStore.getState(),
      })
      if (outcome.kind === "spawned") {
        addPaneToGroup(anchor, outcome.sessionId, direction)
      }
    },
    [
      project,
      activeProjectId,
      settingsTerminalShell,
      settingsForceUtf8,
      settingsSandboxed,
      projectKey,
      addPaneToGroup,
      spawnWithFeedback,
    ]
  )

  // Alt+Arrow cycles focus through the panes of the active group.
  const handleMoveFocus = useCallback(
    (delta: 1 | -1) => {
      const state = useTerminalStore.getState()
      const anchor = state.activeSessionIdByProject[projectKey] ?? null
      if (!anchor) return
      const panes = state.panesForGroup(anchor)
      if (panes.length < 2) return
      const stored = state.focusedPaneByAnchor[anchor]
      const current = stored && panes.includes(stored) ? stored : anchor
      const nextIdx = (panes.indexOf(current) + delta + panes.length) % panes.length
      state.setFocusedPane(anchor, panes[nextIdx])
    },
    [projectKey]
  )

  const handleToggleTrust = useCallback(
    (id: string, trusted: boolean) => {
      setAgentTrusted(id, trusted)
    },
    [setAgentTrusted]
  )

  // Locate the chat session that spawned an agent-driven terminal tab.
  // The dock is global across routes, so switch the active chat session
  // AND navigate to the chat view (root route).
  const router = useRouter()
  const handleLocateInChat = useCallback(
    (chatSessionId: string) => {
      useChatStore.getState().setActiveSession(chatSessionId)
      router.push("/")
    },
    [router]
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
        onClose={handleCloseTab}
        testId="terminal-dock-tabs"
        trailing={
          <>
            <PluginExtensionSlot
              point="terminal.toolbar"
              className="flex items-center gap-1"
              context={{ sessionId: activeId, transport }}
            />
            {transport === "tauri-channel" ? (
              <TerminalShellPicker
                onNew={handleNewWithShell}
                profiles={settingsProfiles}
                onNewProfile={handleNewFromProfile}
              />
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
              onClose={handleCloseTab}
              onCloseOthers={handleCloseOthers}
              onToggleAgentTrust={handleToggleTrust}
              onLocateInChat={handleLocateInChat}
              onCopy={() => void focusedHandleRef.current?.copySelection()}
              onPaste={() => void focusedHandleRef.current?.pasteFromClipboard()}
              onSelectAll={() => focusedHandleRef.current?.selectAll()}
              onClear={() => focusedHandleRef.current?.clearScreen()}
              onFind={() => setSearchOpen(true)}
            >
              <div
                className="h-full w-full"
                onKeyDown={(e) => {
                  const mod = e.ctrlKey || e.metaKey
                  if (mod && (e.key === "f" || e.key === "F")) {
                    e.preventDefault()
                    setSearchOpen(true)
                  } else if (mod && e.key === "\\") {
                    e.preventDefault()
                    void handleSplit(e.shiftKey ? "col" : "row")
                  } else if (mod && e.key === "ArrowUp") {
                    e.preventDefault()
                    focusedHandleRef.current?.jumpToPrevCommand()
                  } else if (mod && e.key === "ArrowDown") {
                    e.preventDefault()
                    focusedHandleRef.current?.jumpToNextCommand()
                  } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
                    e.preventDefault()
                    handleMoveFocus(-1)
                  } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
                    e.preventDefault()
                    handleMoveFocus(1)
                  }
                }}
              >
                <TerminalPaneGroup
                  anchorId={activeRow.id}
                  onFocusedChange={onFocusedChange}
                  onClosePane={handleClosePane}
                />
              </div>
            </TerminalTabContextMenu>
            <TerminalSearchOverlay
              open={searchOpen}
              onClose={() => setSearchOpen(false)}
              instanceRef={focusedHandleRef}
            />
            <TerminalHistoryPanel
              sessionId={
                focusedSessionId && sessions[focusedSessionId] ? focusedSessionId : activeRow.id
              }
              onLocateInChat={handleLocateInChat}
            />
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
      {/* Read-only viewer for clicked terminal file links (1D). */}
      <FileViewerDialog />
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
