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
 * Mounted by `components/terminal/terminal-dock-region.tsx`, which owns the
 * animated shell slot and the bottom/right sizing. The dock itself only knows
 * which edge it is on (to flip its border and its resize separator) — not how
 * that edge is laid out.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  Columns2Icon,
  EraserIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
  Share2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { type TerminalProfile } from "@/lib/terminal/profiles"
import { connectSshFromDock, resolveSshHostLaunch } from "@/lib/terminal/ssh-connect"
import { useSshHostKeyChange } from "@/hooks/terminal/use-ssh-host-key-change"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { nextDockPosition } from "@/lib/terminal/dock-position"
import { spawnDefaultTerminal } from "@/lib/terminal/spawn-default"
import {
  detachFromDock,
  killFromDock,
  restartFromDock,
  type SpawnOutcome,
} from "@/lib/terminal/spawn-orchestrator"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { isTauri } from "@/lib/tauri"
import { useEdgeResize } from "@/hooks/ui/use-edge-resize"
import { useTerminalTransport } from "@/hooks/terminal/use-terminal-transport"
import { usePlatform } from "@/hooks/use-platform"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { PanelRootChip } from "@/components/workspace/panel-root-chip"
import { useSessionExecutionContext } from "@/hooks/workspace/use-session-execution-context"
import { resolvePanelRoot } from "@/lib/workspace/panel-follow"
import { useSettingsStore } from "@/stores/settings"
import {
  orderTabRows,
  TERMINAL_LAYOUT_BOUNDS,
  useTerminalStore,
  type TerminalSessionRow,
} from "@/stores/terminal/terminal-store"

import { TerminalDockGrip } from "./terminal-dock-grip"
import { TerminalEmptyState, type TerminalEmptyStateVariant } from "./terminal-empty-state"
import { TerminalForwardPanel } from "./terminal-forward-panel"
import { TerminalHistoryPanel } from "./terminal-history-panel"
import { TerminalHostStateBanner } from "./terminal-host-state-banner"
import { type TerminalInstanceHandle } from "./terminal-instance"
import { TerminalPaneGroup } from "./terminal-pane-group"
import { TerminalSearchOverlay } from "./terminal-search-overlay"
import { TerminalShareDialog } from "./terminal-share-dialog"
import { TerminalShellPicker } from "./terminal-shell-picker"
import { TerminalTabContextMenu } from "./terminal-tab-context-menu"
import type { TabColorPreset, TabIconPreset } from "@/lib/terminal/tab-appearance"
import { TerminalTabStrip } from "./terminal-tab-strip"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { messagePermalinkQuery } from "@/lib/chat/message-permalink"

export function TerminalDock() {
  const t = useTranslations("terminal.dock")
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const setPanelOpen = useTerminalStore((s) => s.setPanelOpen)
  const sessions = useTerminalStore((s) => s.sessions)
  const activeByProject = useTerminalStore((s) => s.activeSessionIdByProject)
  const splitPanes = useTerminalStore((s) => s.splitPanes)
  const setActiveSession = useTerminalStore((s) => s.setActiveSession)
  const renameSession = useTerminalStore((s) => s.renameSession)
  const setTabAppearance = useTerminalStore((s) => s.setTabAppearance)
  const setAgentTrusted = useTerminalStore((s) => s.setAgentTrusted)
  const addPaneToGroup = useTerminalStore((s) => s.addPaneToGroup)

  const setPanelSize = useTerminalStore((s) => s.setPanelSize)
  const panelPosition = useTerminalStore((s) => s.panelPosition)
  const setPanelPosition = useTerminalStore((s) => s.setPanelPosition)
  const panelHeightPct = useTerminalStore((s) => s.panelHeightPct)
  const panelWidthPct = useTerminalStore((s) => s.panelWidthPct)
  const maximized = useTerminalStore((s) => s.maximized)
  const toggleMaximized = useTerminalStore((s) => s.toggleMaximized)
  const tabOrder = useTerminalStore((s) => s.tabOrder)
  const setTabOrder = useTerminalStore((s) => s.setTabOrder)
  const outputThrottled = useTerminalStore((s) => s.outputThrottled)
  const tabActivity = useTerminalStore((s) => s.tabActivity)

  // Only the id: shell / cwd / env resolution moved into `spawnDefaultTerminal`,
  // so subscribing to the whole project row here would re-render the dock on
  // every unrelated project edit.
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  // Confirm before killing a tab that's still running a command. On by default
  // (VS Code parity) — guards against an accidental × losing an in-flight run.
  const confirmOnClose = useSettingsStore(
    (s) =>
      (s.settings?.terminal as { confirmOnClose?: boolean } | undefined)?.confirmOnClose ?? true
  )
  const settingsProfiles = useSettingsStore(
    (s) => (s.settings?.terminal as { profiles?: TerminalProfile[] } | undefined)?.profiles
  )
  // Through the shared selector, never an inline settings path. Three call
  // sites once spelled this `settings.terminalSettings`, a key `AppSettings`
  // has never declared, so every saved host silently resolved to `undefined`.
  const settingsSshHosts = useSettingsStore(selectSavedSshHosts)
  /**
   * The changed-host-key adjudication, shared with Settings and the device
   * console. The dock previously toasted the raw native payload, which is JSON
   * and offers the user nothing to act on.
   */
  const hostKeyGuard = useSshHostKeyChange()

  const projectKey = activeProjectId ?? ""

  // Where a new terminal will open — the same resolution `spawnDefaultTerminal`
  // performs, so the chip cannot disagree with the shell it describes.
  const activeChatSessionId = useChatStore((s) => s.activeSessionId)
  const terminalExecutionContext = useSessionExecutionContext(activeChatSessionId)
  const activeProject = useProjectStore((s) =>
    activeProjectId ? (s.projects.find((p) => p.id === activeProjectId) ?? null) : null
  )
  const terminalRootTarget = useMemo(
    () =>
      resolvePanelRoot({
        panel: "terminal",
        executionContext: terminalExecutionContext,
        activeProject,
      }),
    [terminalExecutionContext, activeProject]
  )
  const tabs = useMemo<TerminalSessionRow[]>(() => {
    // Tab strip lists group anchors only — split-pane members are hidden
    // (they render inside their anchor's TerminalPaneGroup).
    const isGroupMember = (id: string) =>
      Object.values(splitPanes).some((members) => members.includes(id))
    // Same ordering helper `tabsForProject()` uses, so the strip and every
    // action that walks the tab list cannot disagree about the order.
    return orderTabRows(
      Object.values(sessions)
        .filter((row) => (row.projectId ?? "") === projectKey)
        .filter((row) => !isGroupMember(row.id)),
      tabOrder[projectKey]
    )
  }, [sessions, splitPanes, projectKey, tabOrder])

  const throttledIds = useMemo(
    () => new Set(Object.keys(outputThrottled).filter((id) => outputThrottled[id])),
    [outputThrottled]
  )

  const activityIds = useMemo(
    () => new Set(Object.keys(tabActivity).filter((id) => tabActivity[id])),
    [tabActivity]
  )

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
  // ADR-0133: share the focused session with paired devices.
  const [shareOpen, setShareOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  // Anchor id of the tab awaiting close confirmation (running-command guard).
  const [closeConfirmTarget, setCloseConfirmTarget] = useState<string | null>(null)

  // Spawn + surface failures. Without this, an `error`/`denied` outcome was
  // dropped silently — the user clicked "+ New" and nothing happened, no
  // toast. Now every spawn path reports why it failed (incl. the spawn
  // timeout that guards against a wedged backend).
  // Spawn + surface failures. Without this, an `error`/`denied` outcome was
  // dropped silently — the user clicked "+ New" and nothing happened, no
  // toast. Now every spawn path reports why it failed (incl. the spawn
  // timeout that guards against a wedged backend).
  //
  // The shell/profile/cwd precedence itself lives in
  // `lib/terminal/spawn-default.ts` so the title bar's Terminal → New resolves
  // it identically instead of re-deriving it.
  const spawnWithFeedback = useCallback(
    async (opts?: Parameters<typeof spawnDefaultTerminal>[0]): Promise<SpawnOutcome> => {
      const outcome = await spawnDefaultTerminal(opts)
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
    (shellOverride?: string) => {
      void spawnWithFeedback({ shellOverride })
    },
    [spawnWithFeedback]
  )

  const handleNewFromProfile = useCallback(
    (profileId: string) => {
      void spawnWithFeedback({ profileId })
    },
    [spawnWithFeedback]
  )

  /**
   * Connect a saved SSH host straight from the dock.
   *
   * Deliberately bypasses `spawnWithFeedback`: SSH does not go through
   * `spawnDefaultTerminal`'s shell/profile/cwd precedence, and its outcome
   * carries the host-key verdict the user needs to see on first connect.
   * Secrets stay where they are — the dock offers no secret field, so a
   * password host that has never been connected from settings is sent back
   * there rather than failing with a bare native error.
   */
  const handleNewSshHost = useCallback(
    async (hostId: string) => {
      const launch = resolveSshHostLaunch(hostId, settingsSshHosts)
      if (launch.kind === "unknownHost") return
      if (launch.kind === "credentialRequired") {
        toast.error(t("sshCredentialRequired", { name: launch.name }))
        return
      }
      const result = await connectSshFromDock({
        profile: launch.profile,
        // A jump host is stored as a profile id, so the whole set has to travel
        // with the one being launched or a bastion-backed host connects direct.
        allProfiles: settingsSshHosts ?? [],
        projectId: activeProjectId ?? undefined,
        rows: 24,
        cols: 80,
        store: useTerminalStore.getState(),
      })
      if (result.kind === "error") {
        // A changed host key is the one connection failure a toast cannot
        // resolve: the user has to see both fingerprints and decide. The dock
        // used to print the raw `ssh_host_key_changed:{…}` payload instead.
        if (hostKeyGuard.capture(result.message)) return
        toast.error(t("spawnError", { message: result.message }))
        return
      }
      if (result.hostKeyStatus === null) {
        // The host connected on our behalf and the terminal wire carries no
        // host-key fields, so there is no verdict to report here.
        toast.success(t("sshConnectedViaHost"))
        return
      }
      toast.success(t(`sshConnected.${result.hostKeyStatus}`), {
        description: result.hostKeyFingerprint ?? undefined,
      })
    },
    [activeProjectId, hostKeyGuard, settingsSshHosts, t]
  )

  /**
   * Open a serial port as a tab.
   *
   * Not routed through `spawnWithFeedback`: a port is not a shell, so none of
   * the profile / cwd / default-shell precedence applies, and the outcome the
   * user needs is whether the device node opened rather than which shell was
   * chosen. `unsupported` is its own outcome because a companion shell has no
   * device node to open, and telling that user their adapter failed would be a
   * lie about their hardware.
   */
  const handleNewSerialPort = useCallback(
    async (path: string, baudRate: number) => {
      const { DEFAULT_SERIAL_CONFIG } = await import("@/lib/terminal/serial")
      const { connectSerialFromDock } = await import("@/lib/terminal/serial-connect")
      const result = await connectSerialFromDock({
        config: { ...DEFAULT_SERIAL_CONFIG, port: path, baudRate },
        projectId: activeProjectId ?? undefined,
        store: useTerminalStore.getState(),
      })
      if (result.kind === "unsupported") {
        toast.error(t("serialDesktopOnly"))
        return
      }
      if (result.kind === "error") {
        toast.error(t("serialOpenError", { path, message: result.message }))
        return
      }
      toast.success(t("serialConnected", { path, baud: baudRate }))
    },
    [activeProjectId, t]
  )

  /**
   * Attach to a running tmux session.
   *
   * Spawns an ordinary shell and writes the attach command into it, which is
   * exactly what `buildTmuxAttachCommand` documents itself as being for: tmux
   * attaches a CLIENT, and the client has to be a process in a PTY. There is
   * no native "attach" to call.
   */
  const handleAttachTmuxSession = useCallback(
    async (sessionName: string) => {
      const { buildTmuxAttachCommand } = await import("@/lib/terminal/multiplexer")
      const spawned = await spawnWithFeedback({})
      if (!spawned) return
      const session = getLiveSession(spawned)
      if (!session) return
      await session.write(`${buildTmuxAttachCommand(sessionName)}\n`)
    },
    [spawnWithFeedback]
  )

  /** Plain "+ New": the configured default profile, else the resolved shell. */
  const handleNew = useCallback(() => {
    void spawnWithFeedback()
  }, [spawnWithFeedback])

  // Close a single split pane by detaching this renderer. The host-owned
  // process remains available to other viewers and for later reattachment.
  const handleClosePane = useCallback(
    (id: string) => {
      void detachFromDock(id, useTerminalStore.getState()).catch((error) => {
        toast.error(
          t("detachError", { message: error instanceof Error ? error.message : String(error) })
        )
      })
    },
    [t]
  )

  // Close a whole tab — kills every pane in the group.
  const doCloseTab = useCallback((anchorId: string) => {
    const state = useTerminalStore.getState()
    for (const paneId of state.panesForGroup(anchorId)) {
      void killFromDock(paneId, state)
    }
  }, [])

  const doDetachTab = useCallback(
    (anchorId: string) => {
      const state = useTerminalStore.getState()
      for (const paneId of state.panesForGroup(anchorId)) {
        void detachFromDock(paneId, state).catch((error) => {
          toast.error(
            t("detachError", { message: error instanceof Error ? error.message : String(error) })
          )
        })
      }
    },
    [t]
  )

  // A host-owned process is live even when its shell is currently idle. Closing
  // its tab must detach by default instead of destroying it for every client.
  const groupHasLiveProcess = useCallback((anchorId: string) => {
    const state = useTerminalStore.getState()
    return state
      .panesForGroup(anchorId)
      .some((id) => getLiveSession(id)?.info.alive !== false && !!getLiveSession(id))
  }, [])

  // Close entry point for the × button and the context menu. Routes through a
  // choice dialog while the process is live. The primary action detaches this
  // device; termination is an explicitly destructive secondary action.
  const requestCloseTab = useCallback(
    (anchorId: string) => {
      if (confirmOnClose && groupHasLiveProcess(anchorId)) {
        setCloseConfirmTarget(anchorId)
      } else if (groupHasLiveProcess(anchorId)) {
        doDetachTab(anchorId)
      } else {
        doCloseTab(anchorId)
      }
    },
    [confirmOnClose, groupHasLiveProcess, doCloseTab, doDetachTab]
  )

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
      const anchor = useTerminalStore.getState().activeSessionIdByProject[projectKey] ?? null
      if (!anchor) return
      const outcome = await spawnWithFeedback()
      if (outcome.kind === "spawned") {
        addPaneToGroup(anchor, outcome.sessionId, direction)
      }
    },
    [projectKey, addPaneToGroup, spawnWithFeedback]
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
  //
  // With a spawning message recorded, route through the message permalink
  // instead: the chat page consumes it and scrolls to that turn. ADR-0033
  // deferred exactly this for want of a scroll-to-message seam. Falling back to
  // the plain route keeps tabs spawned before the field existed working.
  const router = useRouter()
  const handleLocateInChat = useCallback(
    (chatSessionId: string, messageId?: string | null) => {
      useChatStore.getState().setActiveSession(chatSessionId)
      router.push(
        messageId ? `/${messagePermalinkQuery({ sessionId: chatSessionId, messageId })}` : "/"
      )
    },
    [router]
  )

  const handleRename = useCallback((id: string) => {
    setRenameTarget(id)
  }, [])

  // The tab colour/icon grids live in the context menu's own submenu, so there
  // is no dialog to open and nothing to hold: the change is committed straight
  // to the store, and `terminal-tab.tsx` already paints `tabColorBorderClass`
  // from the row.
  const handleChangeAppearance = useCallback(
    (id: string, appearance: { color?: TabColorPreset; icon?: TabIconPreset }) => {
      setTabAppearance(id, appearance)
    },
    [setTabAppearance]
  )

  const commitRename = useCallback(
    (id: string, value: string | null) => {
      renameSession(id, value)
      setRenameTarget(null)
    },
    [renameSession]
  )

  const handleReorder = useCallback(
    (orderedIds: string[]) => setTabOrder(activeProjectId, orderedIds),
    [activeProjectId, setTabOrder]
  )

  // Per-tab context menu. Wrapping the tab (rather than the dock body) is what
  // makes rename / restart / close-others reachable for a tab that is not the
  // active one — the body menu can only ever target the active row.
  //
  // No edit group here: copy/paste/clear/find act on the *focused pane*, which
  // only the body menu knows about. `TerminalTabContextMenu` drops that group
  // when its handlers are absent.
  const renderTabWrapper = useCallback(
    (row: TerminalSessionRow, tab: React.ReactNode) => (
      <TerminalTabContextMenu
        key={row.id}
        row={row}
        onRename={handleRename}
        onRestart={handleRestart}
        onClose={requestCloseTab}
        onCloseOthers={handleCloseOthers}
        onToggleAgentTrust={handleToggleTrust}
        onLocateInChat={handleLocateInChat}
        onChangeAppearance={handleChangeAppearance}
      >
        {tab}
      </TerminalTabContextMenu>
    ),
    [
      handleRename,
      handleRestart,
      requestCloseTab,
      handleCloseOthers,
      handleToggleTrust,
      handleLocateInChat,
      handleChangeAppearance,
    ]
  )

  // Reactive transport: activating a remote Cognia host mid-session must move
  // the dock's affordances with it, and `canSpawn` — not "is this the local
  // PTY" — is what a spawn button should key off.
  const { kind: transport, canSpawn } = useTerminalTransport()
  /**
   * The SSH group follows `canSpawn`, not `isLocalPty`.
   *
   * It used to follow `isLocalPty` on the belief that a LAN or WebRTC client
   * had no path to an SSH session. It has one, and always did:
   * `TerminalHost::spawn_synchronized_profile` resolves a named profile out of
   * the host's own `ssh_profiles` map and connects with credentials that never
   * leave it. `connectSshFromDock` now takes that path, so the only question
   * left is whether any host can spawn at all.
   */
  const pickerSshHosts = canSpawn ? settingsSshHosts : undefined
  const platform = usePlatform()

  // Percent-per-CSS-pixel for the axis this dock resizes along, so a pointer
  // delta converts into the same unit the store holds.
  const viewport =
    typeof window === "undefined"
      ? 800
      : panelPosition === "right"
        ? window.innerWidth
        : window.innerHeight
  const axis =
    panelPosition === "right"
      ? {
          min: TERMINAL_LAYOUT_BOUNDS.panelMinWidthPct,
          max: TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct,
          size: panelWidthPct,
          edge: "left" as const,
        }
      : {
          min: TERMINAL_LAYOUT_BOUNDS.panelMinPct,
          max: TERMINAL_LAYOUT_BOUNDS.panelMaxPct,
          size: panelHeightPct,
          edge: "top" as const,
        }
  const resize = useEdgeResize({
    width: axis.size,
    min: axis.min,
    max: axis.max,
    onChange: setPanelSize,
    onReset: toggleMaximized,
    step: 2,
    edge: axis.edge,
    scale: viewport > 0 ? 100 / viewport : 1,
  })

  if (!panelOpen) return null

  const right = panelPosition === "right"
  // The empty state's action depends on whether a session *can* be created,
  // not on which transport would create it — a desktop driving a remote host
  // spawns over `ws` exactly like the mobile screen does.
  const emptyVariant: TerminalEmptyStateVariant =
    transport === "tauri-channel"
      ? "desktop"
      : transport === "ws" || transport === "webrtc"
        ? platform === "tauri"
          ? "remote"
          : platform === "mobile"
            ? "mobile"
            : "cloud"
        : "unsupported"

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col bg-background",
        right ? "border-l" : "border-t"
      )}
      data-testid="terminal-dock"
      data-position={panelPosition}
      data-project-id={activeProjectId ?? "none"}
    >
      {/* Drag-resize separator, pinned to whichever edge faces the rest of the
          workspace: the top edge when docked bottom, the left edge when docked
          right. Dragging away from that edge grows the dock. Keyboard-
          accessible via the axis's arrow keys; double-click toggles maximize
          (both come from `useEdgeResize`). */}
      <div
        role="separator"
        aria-orientation={right ? "vertical" : "horizontal"}
        tabIndex={0}
        aria-label={right ? t("resizeVertical") : t("resize")}
        data-testid="terminal-dock-resize-handle"
        // 10px transparent hit zone (was a 4px sliver — too small to grab,
        // especially by touch) with a 2px visible line centred on the border.
        className={cn(
          "group absolute z-10 flex items-center focus-visible:outline-none",
          right
            ? "-left-1 bottom-0 top-0 w-2.5 cursor-col-resize justify-center"
            : "-top-1 left-0 right-0 h-2.5 cursor-row-resize"
        )}
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        onKeyDown={resize.onKeyDown}
        onDoubleClick={resize.onDoubleClick}
      >
        <span
          aria-hidden
          className={cn(
            "bg-transparent transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
            right ? "h-full w-0.5" : "h-0.5 w-full"
          )}
        />
      </div>
      <TerminalTabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={handleSelect}
        onClose={requestCloseTab}
        testId="terminal-dock-tabs"
        throttledIds={throttledIds}
        activityIds={activityIds}
        onReorder={handleReorder}
        leading={<TerminalDockGrip />}
        renderTabWrapper={renderTabWrapper}
        trailing={
          <>
            {/* Where "+ New" will actually open. A terminal that silently
                retargets is the sharpest version of this problem — the user
                types `rm -rf build` believing they know where they are. No pin
                control: an execution panel always follows. */}
            <PanelRootChip panel="terminal" target={terminalRootTarget} className="mr-1" />
            <PluginExtensionSlot
              point="terminal.toolbar"
              className="flex items-center gap-1"
              context={{ sessionId: activeId, transport }}
            />
            {canSpawn ? (
              <TerminalShellPicker
                onNew={handleNewWithShell}
                profiles={settingsProfiles}
                onNewProfile={handleNewFromProfile}
                sshHosts={pickerSshHosts}
                onNewSshHost={handleNewSshHost}
                onNewSerialPort={isTauri() ? handleNewSerialPort : undefined}
                onAttachTmuxSession={isTauri() ? handleAttachTmuxSession : undefined}
              />
            ) : null}
            {canSpawn && activeRow ? (
              <DockToolbarButton
                label={t("splitRight")}
                testId="terminal-dock-split"
                onClick={() => void handleSplit("row")}
              >
                <Columns2Icon className="h-3 w-3" />
              </DockToolbarButton>
            ) : null}
            {/* Sharing (ADR-0133) rides the durable host: it needs a hosted
                session, and only the desktop can grant paired devices. */}
            {activeRow && transport === "tauri-channel" ? (
              <DockToolbarButton
                label={t("share")}
                testId="terminal-dock-share"
                onClick={() => setShareOpen(true)}
              >
                <Share2Icon className="h-3 w-3" />
              </DockToolbarButton>
            ) : null}
            {/* Clearing is pure xterm — no transport gate. A remote-host user
                could not clear their own screen while this was gated. */}
            {activeRow ? (
              <DockToolbarButton
                label={t("clear")}
                testId="terminal-dock-clear"
                onClick={() => focusedHandleRef.current?.clearScreen()}
              >
                <EraserIcon className="h-3 w-3" />
              </DockToolbarButton>
            ) : null}
            <DockToolbarButton
              label={right ? t("moveToBottom") : t("moveToRight")}
              testId="terminal-dock-move"
              onClick={() => setPanelPosition(nextDockPosition(panelPosition))}
            >
              {right ? (
                <PanelBottomIcon className="h-3 w-3" />
              ) : (
                <PanelRightIcon className="h-3 w-3" />
              )}
            </DockToolbarButton>
            <DockToolbarButton
              label={maximized ? t("restore") : t("maximize")}
              testId="terminal-dock-maximize"
              onClick={toggleMaximized}
            >
              {maximized ? (
                <Minimize2Icon className="h-3 w-3" />
              ) : (
                <Maximize2Icon className="h-3 w-3" />
              )}
            </DockToolbarButton>
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
      <TerminalHostStateBanner
        onRetry={() => {
          useTerminalStore.getState().setHostState("reconnecting")
          void import("@/lib/terminal/rehydrate").then(({ rehydrateTerminals }) =>
            rehydrateTerminals()
          )
        }}
        onOpenSettings={() => router.push("/settings?section=terminal")}
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
              onClose={requestCloseTab}
              onCloseOthers={handleCloseOthers}
              onToggleAgentTrust={handleToggleTrust}
              onLocateInChat={handleLocateInChat}
              onChangeAppearance={handleChangeAppearance}
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
            {shareOpen ? (
              <TerminalShareDialog
                sessionId={
                  focusedSessionId && sessions[focusedSessionId] ? focusedSessionId : activeRow.id
                }
                open={shareOpen}
                onOpenChange={setShareOpen}
              />
            ) : null}
            <TerminalHistoryPanel
              sessionId={
                focusedSessionId && sessions[focusedSessionId] ? focusedSessionId : activeRow.id
              }
              onLocateInChat={handleLocateInChat}
            />
            {/* Hides itself for a local shell, and for an SSH tab with no rules.
                Keyed by session so switching tabs cannot leave another tab's
                tunnels on screen while the first poll is in flight. */}
            <TerminalForwardPanel
              key={focusedSessionId && sessions[focusedSessionId] ? focusedSessionId : activeRow.id}
              sessionId={
                focusedSessionId && sessions[focusedSessionId] ? focusedSessionId : activeRow.id
              }
            />
            {renameTarget && sessions[renameTarget] ? (
              <DockRenameOverlay
                row={sessions[renameTarget]}
                onCommit={(v) => commitRename(renameTarget, v)}
                onCancel={() => setRenameTarget(null)}
              />
            ) : null}
          </>
        ) : (
          <TerminalEmptyState variant={emptyVariant} onNew={canSpawn ? handleNew : undefined} />
        )}
      </div>
      {/* Read-only viewer for clicked terminal file links (1D). */}
      {/* Live sessions default to detach; termination is always explicit. */}
      <AlertDialog
        open={closeConfirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCloseConfirmTarget(null)
        }}
      >
        <AlertDialogContent data-testid="terminal-dock-close-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("closeConfirm.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="terminal-dock-close-confirm-cancel">
              {t("closeConfirm.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              data-testid="terminal-dock-close-terminate"
              onClick={() => {
                if (closeConfirmTarget) doCloseTab(closeConfirmTarget)
                setCloseConfirmTarget(null)
              }}
            >
              {t("closeConfirm.terminate")}
            </Button>
            <AlertDialogAction
              data-testid="terminal-dock-close-confirm-accept"
              onClick={() => {
                if (closeConfirmTarget) doDetachTab(closeConfirmTarget)
                setCloseConfirmTarget(null)
              }}
            >
              {t("closeConfirm.detach")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {hostKeyGuard.dialog}
    </div>
  )
}

/**
 * Ghost icon button for the dock's trailing toolbar. The label doubles as the
 * accessible name and the native hover tooltip (which carries the keyboard
 * shortcut) — no Radix TooltipProvider dependency, so it works everywhere the
 * dock mounts.
 */
function DockToolbarButton({
  label,
  testId,
  onClick,
  children,
}: {
  label: string
  testId: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="h-7 w-7 p-0"
    >
      {children}
    </Button>
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
