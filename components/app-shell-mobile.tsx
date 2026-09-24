"use client"

/**
 * Mobile shell (M4.2 / #46).
 *
 * Replaces the multi-pane Discord-style desktop layout with a Sheet/
 * Drawer-based phone UX:
 *
 *   ┌────────────── Top bar (56px) ──────────────┐
 *   │ ☰   Session title              ⋯           │
 *   ├────────────────────────────────────────────┤
 *   │                                            │
 *   │              ChatPane (single-pane)        │
 *   │                                            │
 *   └────────────────────────────────────────────┘
 *
 * Left sheet (slide-from-left): GuildRail + ChannelList — the navigation
 * surface that on desktop lives in the side rails.
 *
 * Right sheet (slide-from-bottom): per-session actions menu (settings,
 * character picker, member list when applicable, sign-out).
 *
 * Mounted via `app/page.tsx` only when `usePlatform() === "mobile"`. On
 * Tauri / web the desktop chrome (`DesktopAppShell` + `DesktopChatWorkspace`)
 * continues to render unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  InboxIcon,
  LayoutGridIcon,
  MenuIcon,
  MoreVerticalIcon,
  PanelRightOpenIcon,
  SearchIcon,
  SettingsIcon,
  Settings2Icon,
  Share2Icon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ChatPane } from "@/components/chat/chat-view"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { CharacterPicker } from "@/components/chat/character-picker"
import { GuildRail } from "@/components/shell/guild-rail"
import { TeamMembersPanel } from "@/components/context-workbench/panels/team-members-panel"
import { CharacterHeader } from "@/components/mobile/shell/character-header"
import { BackgroundRunsChip } from "@/components/chat/background-runs-chip"
import { MobileWorkspaceChip } from "@/components/mobile/shell/mobile-workspace-chip"
import { MobileChannelList } from "@/components/mobile/shell/mobile-channel-list"
import { MobileChannelListSourceProvider } from "@/components/mobile/shell/mobile-channel-list-source"
import { MobileChatRuntimeNotice } from "@/components/mobile/shell/mobile-chat-runtime-notice"
import { MobileCredentialWarning } from "@/components/mobile/shell/mobile-credential-warning"
import { useEdgeSwipe } from "@/hooks/ui/use-edge-swipe"
import { useMediaQuery } from "@/hooks/ui/use-media-query"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { SingleExportDialog } from "@/components/data/export/single-export-dialog"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { SharedSessionPanel } from "@/components/chat/shared-session-panel"
import { SharedSessionJoin } from "@/components/chat/shared-session-join"
import { MobileQuickActions } from "@/components/mobile/home/mobile-quick-actions"
import { MobileActiveRunsCard } from "@/components/mobile/home/mobile-active-runs-card"
import { MobileCommandPalette } from "@/components/mobile/home/mobile-command-palette"
import { MobileHomeLayoutSheet } from "@/components/mobile/home/mobile-home-layout-sheet"
import { JobCenterPanel } from "@/components/desktop/job-center-panel"
import { useMobileHomeLayout } from "@/components/mobile/home/use-mobile-home-layout"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ComposerHandle, ComposerTurnMetadata } from "@/components/chat/composer"
import { turnMetadataSendOptions } from "@/lib/chat/turn-metadata"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { useChatRuntimeGate } from "@/hooks/chat/use-chat-runtime-gate"
import { useClientLiveQuery, useDexieFirstQuery } from "@/hooks/data"
import { useChatStore } from "@/stores/chat"
import type { ChatTemplateRun } from "@/lib/chat/template/run"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { whenSeeded } from "@/lib/db/schema"
import { loadMobileUnread } from "@/lib/inbox/unread-count"
import { openSessionForReading } from "@/lib/chat/unread-marker"
import { listCharacters } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"
import { guildFromSession } from "@/lib/claude/guild"
import { isChatHomeActive } from "@/lib/shell/guild-session-sync"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import {
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"
import { useProjectStore } from "@/stores/project/project-store"
import { NewChatExecutionPicker } from "@/components/chat/new-chat-execution-picker"
import { useNewChatExecution } from "@/hooks/chat/use-new-chat-execution"
import { loggers } from "@cognia/logging"
import type { Character, SendContent, Team } from "@cognia/agent-config-types"
import { onComposerMentionRequest } from "@/lib/chat/composer-mention-request"
import { impact, notify } from "@/lib/capacitor/haptics"
import { PerfCaptureShellStatus } from "@/components/performance/perf-capture-shell-status"

const log = loggers.shell

/**
 * Width tiers for the app bar's secondary controls.
 *
 * The bar's fixed cost at 375px is 303px — burger, workspace chip, job centre,
 * search, ⋮, their gaps and the row's own padding — which leaves 72px for the
 * session title and nothing else. Every control beyond that has to earn its
 * place by width, so the two with a cheap menu equivalent (a route push and a
 * store toggle) are the ones that fold.
 *
 * Viewport queries rather than a container query on the header: the ⋮ menu is
 * portaled to `document.body`, so a container ancestor cannot reach the folded
 * copies and the two halves of the decision would drift apart. The header spans
 * the viewport on this shell, which makes the two measurements the same number.
 */
const APPBAR_INBOX_QUERY = "(min-width: 26rem)"
const APPBAR_ARTIFACTS_QUERY = "(min-width: 30rem)"
/**
 * The missing-credential warning's text label. Below this the warning is a key
 * icon (see `MobileCredentialWarning`): at 375px a shrinkable label pill was
 * clipped to "o API k", and a blocking warning that cannot be read is worse
 * than an icon that can.
 */
const APPBAR_KEY_LABEL_QUERY = "(min-width: 36rem)"

/**
 * While the drawer is open it answers only to gestures that start on it or on
 * its own overlay. A sheet or dialog opened from inside it (a row's action
 * sheet, the delete confirm, the filter drawer) is portaled outside, and a
 * sideways drag there is not a request to put the drawer away underneath it.
 */
const NAV_DRAWER_GESTURE_SURFACE = '[data-mobile-nav-sheet], [data-slot="sheet-overlay"]'

export function AppShellMobile() {
  const t = useTranslations("desktop.shell")
  const tShell = useTranslations("mobile.shell")
  const router = useRouter()
  // Same reach contract as the desktop sidebar: grouping by workspace, or a
  // search told to reach every workspace, loads the cross-workspace list.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const sidebarGroupBy = resolveConversationGroupBy(sidebarSettings)
  const sidebarSearch = resolveConversationSearchOptions(sidebarSettings)
  const {
    sessions,
    isLoadingSessions,
    activeSessionId,
    select,
    create,
    remove,
    rename,
    archive,
    unarchive,
    bulkSetPinned,
    assignToFolder,
    folders,
  } = useSessions({
    crossWorkspace: needsCrossWorkspaceSessions(sidebarGroupBy, sidebarSearch),
  })
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const chatStatus = useChatStore((s) => s.status)
  const activeSessionEpoch = useChatStore((s) => s.activeSessionEpoch)
  const clearActiveSession = useChatStore((s) => s.clearActiveSession)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const selectedGuildEpoch = useUIStore((s) => s.selectedGuildEpoch)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const chatHomeEpoch = useUIStore((s) => s.chatHomeEpoch)
  const requestChatHome = useUIStore((s) => s.requestChatHome)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)
  const { isSectionHidden } = useMobileHomeLayout()

  const { keyOk } = useCredentialStatus()
  // Same send gate as the desktop workspace: a paired phone whose host is
  // offline, unpaired or missing the chat grant must not offer a composer.
  const chatRuntime = useChatRuntimeGate()

  const [navOpen, setNavOpen] = useState(false)
  const [memberSheetOpen, setMemberSheetOpen] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)
  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [homeLayoutOpen, setHomeLayoutOpen] = useState(false)
  const [mounted, setMounted] = useState(false)

  // App-bar width tiers (see the query constants above). `useMediaQuery`
  // answers `false` before hydration, so the first paint is the narrow bar and
  // a wider device widens it on mount — never the other way round, which is the
  // direction that would flash an overflowing row.
  const inboxInBar = useMediaQuery(APPBAR_INBOX_QUERY)
  const artifactsInBar = useMediaQuery(APPBAR_ARTIFACTS_QUERY)
  const keyLabelInBar = useMediaQuery(APPBAR_KEY_LABEL_QUERY)
  const toggleArtifactDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const unreadArtifact = useArtifactDockLayoutStore((s) => s.unreadArtifact) && dockCollapsed

  const composerRef = useRef<ComposerHandle | null>(null)
  // The members sheet asks for an `@mention` over the shared seam (it renders
  // the same host-agnostic panel the desktop workbench does); inserting into
  // the composer means the sheet has done its job and should get out of the
  // way (`lib/chat/composer-mention-request.ts`).
  useEffect(
    () =>
      onComposerMentionRequest((name) => {
        composerRef.current?.insertMention(name)
        setMemberSheetOpen(false)
      }),
    []
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    void whenSeeded()
  }, [])

  useEffect(() => {
    if (typeof document === "undefined") return
    document.body.setAttribute("data-app-shell", "true")
    return () => document.body.removeAttribute("data-app-shell")
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // IM panes own read capture on every host, including embedded surfaces.
  const shellReadSessionId = sessions.find(
    (session) => session.id === activeSessionId && !session.platformBinding
  )?.id
  useEffect(() => {
    if (!shellReadSessionId) return
    void openSessionForReading(shellReadSessionId).catch((err) => {
      log.warn("markSessionRead failed", {
        sessionId: shellReadSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, [shellReadSessionId])

  // Auto-select most recent session matching the current guild — except while
  // a New-chat intent is newest: the welcome screen is the destination then,
  // and resuming the latest conversation would bounce the user right back.
  useEffect(() => {
    if (!mounted) return
    if (activeSessionId) {
      const current = sessions.find((s) => s.id === activeSessionId)
      if (current && selectedGuild.kind === "team") {
        if (current.kind !== "team" || current.teamId !== selectedGuild.teamId) {
          setSelectedGuild(guildFromSession(current))
        }
      }
      return
    }
    if (isChatHomeActive(chatHomeEpoch, selectedGuildEpoch, activeSessionEpoch)) return
    const matching = sessions.find((s) => {
      if (selectedGuild.kind === "team") {
        return s.kind === "team" && s.teamId === selectedGuild.teamId
      }
      return s.kind !== "team"
    })
    if (matching) {
      select(matching.id)
    }
  }, [
    mounted,
    sessions,
    activeSessionId,
    selectedGuild,
    chatHomeEpoch,
    selectedGuildEpoch,
    activeSessionEpoch,
    select,
    setSelectedGuild,
  ])

  // Surface non-fatal errors as toasts.
  useEffect(() => {
    if (errorMessage && errorMessage !== lastErrorShown) {
      toast.error(errorMessage)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastErrorShown(errorMessage)
    } else if (!errorMessage) {
      setLastErrorShown(null)
    }
  }, [errorMessage, lastErrorShown])

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
  const [exportOpen, setExportOpen] = useState(false)

  // The drawer's second way in and out. The hamburger stays where it is, but a
  // phone reaches the leading edge far more easily than the top-left corner of
  // a tall screen, and every other drawer on the platform answers to the same
  // drag. Vertical intent still wins, so scrolling the conversation cannot
  // summon it (`hooks/ui/use-edge-swipe.ts`).
  //
  // Disarmed while any other sheet or dialog owns the screen. A gesture aimed
  // at the surface in front cannot be told apart from one aimed at the shell
  // behind it, and answering both stacks the navigation drawer under a sheet
  // the user is still reading. The close half is guarded on the drawer being
  // open for the same reason `ChannelList` guards its own: an outward swipe is
  // a gesture anywhere on screen, and a carousel or a swipeable row must not
  // spend it on a drawer that was never out.
  const modalSurfaceOpen =
    memberSheetOpen || sessionSettingsOpen || searchOpen || characterPickerOpen || exportOpen
  useEdgeSwipe({
    edge: "left",
    enabled: !modalSurfaceOpen,
    onOpen: () => setNavOpen(true),
    onClose: () => {
      if (navOpen) setNavOpen(false)
    },
    ignore: (target) => navOpen && target.closest(NAV_DRAWER_GESTURE_SURFACE) === null,
  })

  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)

  // Was a count of `inboundLedger` rows newer than `lastInboxViewedAt`. That
  // ledger is host-only and never syncs, so the dot was permanently dark on a
  // paired device. `sessionState` does sync, and restricting it to
  // IM/integration-bound conversations keeps this dot about the Inbox rather
  // than about all chat (the Chat tab badge is the all-chat number).
  const inboxUnread = useClientLiveQuery(
    () => loadMobileUnread().then((counts) => counts.inbox),
    [],
    0
  )

  // Attention carried by whichever controls the current width folded into ⋮.
  // Computed from the same two signals their in-bar dots read, so folding a
  // control moves its dot rather than deleting it.
  const foldedAttention =
    (!inboxInBar && (inboxUnread ?? 0) > 0) || (!artifactsInBar && unreadArtifact)

  // Dexie-first, with the one sync kick for the table, and shared with the
  // drawer's conversation list through its source provider below — which is
  // mounted outside the drawer, so opening it no longer re-reads and re-syncs
  // characters every time.
  const { data: characters } = useDexieFirstQuery<Character[]>({
    query: () => listCharacters(),
    deps: [],
    initial: [],
    table: "characters",
  })
  const activeCharacter = useMemo(() => {
    if (!activeSession || activeSession.kind === "team" || !activeSession.characterId) return null
    return (characters ?? []).find((c) => c.id === activeSession.characterId) ?? null
  }, [characters, activeSession])
  const activeTeam = useClientLiveQuery<Team | undefined>(
    () =>
      isTeamSession && activeSession?.teamId
        ? getTeam(activeSession.teamId)
        : Promise.resolve(undefined),
    [isTeamSession, activeSession?.teamId],
    undefined
  )
  const headerSubject = isTeamSession ? (activeTeam ?? null) : activeCharacter

  const stop = isTeamSession ? teamChat.stop : directChat.stop
  // Tactile confirmation for the primary chat action: a light impact once the
  // turn dispatches, an error notification if it throws. Both no-op off-mobile
  // (the haptics wrapper resolves `unsupported`), so wrapping is harmless.
  const handleSend = useCallback(
    async (
      content: SendContent,
      manifest?: readonly AttachmentManifestEntry[],
      templateRun?: ChatTemplateRun | null,
      turnMetadata?: ComposerTurnMetadata
    ) => {
      try {
        if (isTeamSession) {
          await teamChat.send(content, {
            templateRun: templateRun ?? undefined,
            attachmentManifest: manifest,
            ...turnMetadataSendOptions(turnMetadata),
          })
        } else {
          await directChat.send(content, undefined, {
            attachmentManifest: manifest,
            templateRun,
            ...turnMetadataSendOptions(turnMetadata),
          })
        }
        void impact("light")
      } catch (err) {
        void notify("error")
        throw err
      }
    },
    [directChat, isTeamSession, teamChat]
  )
  // Where a new conversation runs: the local checkout, or an isolated worktree.
  // Mobile created every session with a bare `create({ kind: "direct" })`, so
  // it always took the workspace default and a phone had no way to say
  // otherwise. Same hook as the desktop, so the defaulting rules cannot drift.
  const {
    value: newChatExecution,
    setValue: setNewChatExecution,
    rootDir: newChatExecutionRoot,
  } = useNewChatExecution()

  // First turn from the welcome screen's hero composer. `handleSend` above
  // targets whatever session is active, and on the welcome screen there is
  // none — `send` would drop the message. Create one first, then send into it
  // explicitly (the store pointer has not reached this closure yet).
  //
  // A bare `create()` auto-applies the default preset, so typing a first
  // message does not force a character pick the way the "+" button does.
  const handleFirstTurn = useCallback(
    async (
      content: SendContent,
      manifest?: readonly AttachmentManifestEntry[],
      templateRun?: ChatTemplateRun | null,
      turnMetadata?: ComposerTurnMetadata
    ) => {
      if (useChatStore.getState().activeSessionId) {
        await handleSend(content, manifest, templateRun, turnMetadata)
        return
      }
      const s = await create({
        kind: "direct",
        executionLocation: newChatExecution.location,
        executionBase: newChatExecution.base,
      })
      select(s.id)
      setSelectedGuild({ kind: "dm" })
      await directChat.send(content, undefined, {
        sessionId: s.id,
        attachmentManifest: manifest,
        templateRun,
        ...turnMetadataSendOptions(turnMetadata),
      })
      void impact("light")
    },
    [create, select, setSelectedGuild, directChat, handleSend, newChatExecution]
  )

  const openSettings = (tab?: string) => {
    log.info("open settings (mobile)", { tab: tab ?? "general" })
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

  useEffect(() => {
    if (!pendingSettingsRequest) return
    openSettings(pendingSettingsRequest.tab)
    clearPendingSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSettingsRequest])

  // Every "New chat" door on mobile (⋮ menu, drawer's list, quick-action tile,
  // command palette, composer /clear) lands on the welcome surface — the same
  // rule the desktop shell follows. The character picker is reachable from the
  // welcome's own entry button and the session sheet instead.
  const handleNewDirect = useCallback(() => {
    requestChatHome()
    // The desktop gets its clear from the reconcile; this shell's auto-select
    // effect above only skips resuming — the pointer itself is cleared here.
    clearActiveSession()
  }, [requestChatHome, clearActiveSession])

  const handleCreateTeam = () => openSettings("teams")

  const handleSwitchToSession = (id: string) => {
    const target = sessions.find((s) => s.id === id)
    // Follow the conversation into its workspace before focusing it — see the
    // desktop counterpart in `desktop-chat-workspace.tsx`.
    if (target?.projectId) {
      const { activeProjectId, setActiveProject } = useProjectStore.getState()
      if (target.projectId !== activeProjectId) setActiveProject(target.projectId)
    }
    select(id)
    if (!target) return
    setSelectedGuild(guildFromSession(target))
    setNavOpen(false)
  }

  // Recent sessions for the welcome-page "Continue" group (newest first,
  // excluding the one already open).
  const recentSessions = useMemo(
    () =>
      [...sessions]
        .filter((s) => s.id !== activeSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4)
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
    [sessions, activeSessionId]
  )

  const headerTitle = activeSession?.title ?? t("emptyTitle", { default: "cognia" })

  return (
    <div
      // `h-full min-h-0 flex-1`, not `h-[100dvh]`. `MobileShellWrapper` now
      // gives `/` the full-viewport branch, a definite-height flex column that
      // has ALREADY subtracted the tab-bar reserve, so re-asserting a whole
      // viewport here would add that reserve back and push the last 56px of the
      // shell under the bar again. `flex-1` rather than height alone because
      // the wrapper puts the offline banner and the first-run setup bar in that
      // same column above us: a plain `h-full` would claim the WHOLE column and
      // overflow it by however tall those rows are on the day they appear.
      // Same three-class idiom as `FeaturePageShell`'"'"'s compact branch.
      className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-background text-foreground safe-area-pt safe-area-px"
      data-testid="app-shell-mobile"
    >
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header
        // `overflow-hidden` + shrinkable middle items is the whole horizontal
        // contract: the action group on the right is `shrink-0`, so anything
        // that grows (session title, workspace name, credential warning) gives
        // up width instead of pushing the row past the viewport. Without it the
        // bar measured 403px inside a 375px shell, the ⋮ menu — the only way to
        // reach new chat / settings / export / delete — sat off-screen, and the
        // document gained a horizontal scroll that dragged every `position:
        // fixed` layer (the tab bar included) out of alignment with it.
        className="flex h-14 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-2"
        data-app-chrome
      >
        {/* The list's long-lived state (characters, teams, unread, search,
            scroll position) lives here, outside the drawer: Radix unmounts
            closed SheetContent, and the list used to rebuild all of it on
            every open. */}
        <MobileChannelListSourceProvider characters={characters}>
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="touch-target"
                aria-label={tShell("openNav")}
                data-testid="mobile-nav-trigger"
              >
                <MenuIcon className="size-5" />
              </Button>
            </SheetTrigger>

            <SheetContent
              side="left"
              // No corner close button: it sat on top of the list's New chat
              // "+" (the overlay, Escape and the edge swipe all close the
              // drawer). The drawer is portaled out of the shell, so the shell's
              // own safe-area padding never reached it — it reserves the notch,
              // the home indicator and a landscape left inset itself.
              showCloseButton={false}
              className="flex w-[85vw] max-w-sm flex-col gap-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] sm:max-w-md md:max-w-lg"
              data-testid="mobile-nav-sheet"
              data-mobile-nav-sheet=""
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{tShell("navSheetTitle")}</SheetTitle>
              </SheetHeader>
              {/* The overlay, Escape and the edge swipe are gestures a screen
                reader cannot always reach, so the drawer still owns an
                explicit close control — just not one painted over the list's
                "+". Hidden until keyboard focus lands on it, then shown in
                the corner the old button used. */}
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-[calc(env(safe-area-inset-top)+0.5rem)] focus-visible:right-2 focus-visible:z-10"
                  data-testid="mobile-nav-close"
                >
                  {tShell("closeNav")}
                </Button>
              </SheetClose>
              <SharedSessionJoin />
              <div className="flex flex-1 overflow-hidden">
                {/* `variant="sheet"` drops the rail's `md:` breakpoint gate. A
                  phone viewport never reaches `md`, so the default rail variant
                  rendered this whole column — workspace switcher, DM/Canvas,
                  pinned destinations, "More", teams, Settings — as
                  `display:none`, leaving the drawer with only the session
                  list. */}
                <GuildRail
                  variant="sheet"
                  onCreateTeam={handleCreateTeam}
                  onOpenSettings={() => {
                    setNavOpen(false)
                    openSettings()
                  }}
                />
                {/* `min-w-0`: without it this flex item's minimum width is
                  its content's, and a nowrap title stretched the list to
                  842px inside a 262px slot. */}
                <div
                  className="flex min-w-0 flex-1 overflow-hidden"
                  data-testid="mobile-nav-list-slot"
                >
                  {/* The list surfaces its own failures; the writers are
                    handed over un-voided so it can await them. */}
                  <MobileChannelList
                    sessions={sessions}
                    isLoadingSessions={isLoadingSessions}
                    activeSessionId={activeSessionId}
                    onSelect={handleSwitchToSession}
                    onNewDirect={() => {
                      setNavOpen(false)
                      handleNewDirect()
                    }}
                    onDelete={remove}
                    onRename={rename}
                    onArchive={archive}
                    onUnarchive={unarchive}
                    onSetPinned={bulkSetPinned}
                    onAssignToFolder={assignToFolder}
                    folders={folders}
                  />
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </MobileChannelListSourceProvider>

        <CharacterHeader
          subject={headerSubject}
          fallbackTitle={headerTitle}
          streaming={chatStatus === "streaming"}
        />

        <MobileWorkspaceChip className="ml-2 min-w-0 shrink" />

        {/* A phone shows one conversation, so turns started and navigated away
            from had no representation at all here. Tapping goes to one. */}
        <BackgroundRunsChip
          className="ml-2 min-w-0 shrink"
          onSelect={(id) => {
            setNavOpen(false)
            void select(id)
          }}
        />

        {/* Missing-credential warning stays visible (blocking issue): a tap
            opens the session sheet whose Account section resolves it. Never
            buried in the overflow menu, and never shrunk — it is a fixed
            icon button that grows a label only when the bar has room. */}
        {keyOk === false && activeSession ? (
          <MobileCredentialWarning
            showLabel={keyLabelInBar}
            onResolve={() => setSessionSettingsOpen(true)}
            className="ml-1"
          />
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {/* The artifact dock's only standing affordance on a phone. The copy
              in `chat-header` never mounts here (the chat pane below is given
              `showHeader={false}`), so without this the Sheet could only be
              reached by tapping an artifact card that happened to be in the
              thread — and once closed there was no way back to the session
              panels (artifact library, browser, workspace) at all. It also
              carries the unread dot, which had no host on this breakpoint.

              Folded into the ⋮ menu below the width tier — see
              `APPBAR_ARTIFACTS_QUERY`. */}
          {artifactsInBar ? <ArtifactDockToggle className="touch-target" /> : null}
          <JobCenterPanel compact />

          {inboxInBar ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative touch-target"
              aria-label={tShell("inbox")}
              onClick={() => router.push("/inbox/all")}
              data-testid="mobile-inbox-trigger"
            >
              <InboxIcon className="size-5" />
              {(inboxUnread ?? 0) > 0 ? (
                <span
                  className="absolute right-1 top-1 size-2 rounded-full bg-primary"
                  aria-hidden="true"
                  data-testid="mobile-inbox-unread-dot"
                />
              ) : null}
            </Button>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="touch-target"
            aria-label={tShell("search")}
            onClick={() => setSearchOpen(true)}
            data-testid="mobile-search-trigger"
          >
            <SearchIcon className="size-5" />
          </Button>

          {isTeamSession ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="touch-target"
              aria-label={tShell("openMembers")}
              onClick={() => setMemberSheetOpen(true)}
              data-testid="mobile-members-trigger"
            >
              <UsersIcon className="size-5" />
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative touch-target"
                aria-label={tShell("sessionMenu")}
                data-testid="mobile-actions-trigger"
              >
                <MoreVerticalIcon className="size-5" />
                {/* A folded control keeps its attention signal. Without this the
                    inbox / artifact dots simply vanished at phone width, which
                    is a worse outcome than the crowded bar they came from. */}
                {foldedAttention ? (
                  <span
                    className="absolute right-1 top-1 size-2 rounded-full bg-primary"
                    aria-hidden="true"
                    data-testid="mobile-actions-unread-dot"
                  />
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleNewDirect} data-testid="mobile-action-new-chat">
                <UserPlusIcon className="size-4" />
                <span>{tShell("newChat")}</span>
              </DropdownMenuItem>
              {/* The width-folded halves of the app bar. Rendered here ONLY when
                  the bar could not hold them, so neither control is ever
                  reachable twice on the same screen. */}
              {inboxInBar ? null : (
                <DropdownMenuItem
                  onSelect={() => router.push("/inbox/all")}
                  data-testid="mobile-action-inbox"
                >
                  <InboxIcon className="size-4" />
                  <span>{tShell("inbox")}</span>
                  {(inboxUnread ?? 0) > 0 ? (
                    <span
                      className="ms-auto size-2 rounded-full bg-primary"
                      aria-hidden="true"
                      data-testid="mobile-action-inbox-unread-dot"
                    />
                  ) : null}
                </DropdownMenuItem>
              )}
              {artifactsInBar ? null : (
                <DropdownMenuItem
                  onSelect={() => toggleArtifactDock()}
                  data-testid="mobile-action-artifacts"
                >
                  <PanelRightOpenIcon className="size-4" />
                  <span>{tShell("artifacts")}</span>
                  {unreadArtifact ? (
                    <span
                      className="ms-auto size-2 rounded-full bg-primary"
                      aria-hidden="true"
                      data-testid="mobile-action-artifacts-unread-dot"
                    />
                  ) : null}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {/* The home layout editor's ONLY always-reachable entry. Its other
                  door is the "Edit" button inside the quick-action grid, and
                  that grid renders nothing once its own section is hidden — so
                  turning it off used to be a one-way trip. */}
              <DropdownMenuItem
                onSelect={() => {
                  // Defer so the menu can close before the sheet grabs focus.
                  setTimeout(() => setHomeLayoutOpen(true), 0)
                }}
                data-testid="mobile-action-home-layout"
              >
                <LayoutGridIcon className="size-4" />
                <span>{tShell("homeLayout")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => openSettings()}
                data-testid="mobile-action-settings"
              >
                <SettingsIcon className="size-4" />
                <span>{tShell("settings")}</span>
              </DropdownMenuItem>
              {activeSession ? (
                <DropdownMenuItem
                  onSelect={() => {
                    // Defer so the menu can close before the sheet grabs focus.
                    setTimeout(() => setSessionSettingsOpen(true), 0)
                  }}
                  data-testid="mobile-action-session-settings"
                >
                  <Settings2Icon className="size-4" />
                  <span>{tShell("sessionSettings")}</span>
                </DropdownMenuItem>
              ) : null}
              {activeSession ? (
                <DropdownMenuItem
                  onSelect={() => {
                    // Defer so the menu can close before the dialog grabs focus.
                    setTimeout(() => setExportOpen(true), 0)
                  }}
                  data-testid="mobile-action-export"
                >
                  <Share2Icon className="size-4" />
                  <span>{tShell("exportConversation")}</span>
                </DropdownMenuItem>
              ) : null}
              {activeSessionId ? (
                <DropdownMenuItem
                  onSelect={() => {
                    if (!activeSessionId) return
                    void remove(activeSessionId).catch((err) =>
                      toast.error(err instanceof Error ? err.message : String(err))
                    )
                  }}
                  data-testid="mobile-action-delete"
                  className="text-destructive focus:text-destructive"
                >
                  <XIcon className="size-4" />
                  <span>{tShell("deleteSession")}</span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {activeSession ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-3 py-1">
          <SharedSessionPanel session={activeSession} />
        </div>
      ) : null}

      <PerfCaptureShellStatus className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-destructive/5 px-3 text-xs" />

      {/* Conversation export / share-link dialog (reuses the desktop flow;
          its download now writes to the device Files app on Capacitor). */}
      {activeSession ? (
        <SingleExportDialog
          session={activeSession}
          open={exportOpen}
          onOpenChange={setExportOpen}
        />
      ) : null}

      {/* Per-session settings (mobile relocates the inner ChatHeader here via
          `showHeader={false}` below). `showAmbientStatus` surfaces the live
          cost badge, plan-mode tasks, and the `chat.header` plugin slot at the
          top of the sheet — the affordances the dropped header used to host. */}
      {activeSession ? (
        <SessionSettingsSheet
          session={activeSession}
          open={sessionSettingsOpen}
          onOpenChange={setSessionSettingsOpen}
          showAmbientStatus
        />
      ) : null}

      {/* ── Chat pane (single column) ─────────────────────────────────── */}
      <main
        // No bottom reserve here. `MobileShellWrapper` owns the one and only
        // <MobileTabBar /> reservation; this used to re-assert it because the
        // shell root was `h-[100dvh]` and escaped the wrapper's padding. The
        // root is `h-full` now, so the padding above already applies and a
        // second copy showed up as a 56px band of bare background between the
        // composer and the bar.
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
        data-bg-target="chat"
      >
        {!mounted ? null : (
          // gap11 — wrap the chat in the artifact dock (mirrors the desktop
          // workspace + /inbox/c). On mobile the dock renders an `ArtifactPanel`
          // bottom Sheet that opens automatically when an artifact is created;
          // without this mount an `ArtifactPart` tap had nothing to open.
          <ArtifactWorkspaceDock>
            <ChatPane
              activeSession={activeSession}
              // The mobile shell renders its own top bar (CharacterHeader) +
              // relocates the inner ChatHeader's affordances into the session
              // settings sheet, so suppress the duplicate inner header.
              showHeader={false}
              onSend={handleSend}
              onStop={stop}
              // Steer parity with desktop: without these the RunStatusBar's
              // "steer now" button never renders and an errored settle would
              // strand the queued steer with no flush affordance.
              onSteerNow={isTeamSession ? teamChat.interruptAndSteer : directChat.interruptAndSteer}
              onSteerFlush={isTeamSession ? teamChat.flushSteer : directChat.flushSteer}
              onRegenerate={isTeamSession ? teamChat.regenerate : directChat.regenerate}
              onEditResend={isTeamSession ? teamChat.editAndResend : directChat.editAndResend}
              onCreate={handleNewDirect}
              onUseSample={(text) => void handleFirstTurn(text)}
              onHeroSend={handleFirstTurn}
              // `handleFirstTurn` sends into an active team room through its
              // own router, which carries no runtime route; with no session it
              // always creates a direct chat, which does.
              heroRouting={!isTeamSession}
              onOpenSettings={openSettings}
              recentSessions={isSectionHidden("recents") ? undefined : recentSessions}
              onResumeSession={handleSwitchToSession}
              composerRef={composerRef}
              runtimeNotice={
                chatRuntime.composerDisabled ? (
                  <MobileChatRuntimeNotice
                    gate={chatRuntime}
                    onNavigate={(href) => router.push(href)}
                    onOpenSettings={openSettings}
                  />
                ) : null
              }
              composerDisabled={chatRuntime.composerDisabled}
              // Same guard as the desktop: only offered when the workspace has
              // a directory, because "Local" means nothing without one.
              newChatExecutionControls={
                newChatExecutionRoot ? (
                  <NewChatExecutionPicker
                    rootDir={newChatExecutionRoot}
                    value={newChatExecution}
                    onChange={setNewChatExecution}
                  />
                ) : undefined
              }
              welcomeExtras={{
                hideSamples: true,
                // Three other doors to a new conversation on this shell: the ⋮
                // menu, the quick-action grid, and the composer right above it
                // (the first send creates the session). The fourth also threw
                // away whatever had been typed.
                hideNewChatAction: true,
                header: <MobileActiveRunsCard />,
                quickActions: (
                  <MobileQuickActions
                    onNewChat={handleNewDirect}
                    onSearch={() => setSearchOpen(true)}
                    onEditLayout={() => setHomeLayoutOpen(true)}
                  />
                ),
              }}
            />
          </ArtifactWorkspaceDock>
        )}
      </main>

      {/* ── Right-side sheets ─────────────────────────────────────────── */}
      {isTeamSession ? (
        <Sheet open={memberSheetOpen} onOpenChange={setMemberSheetOpen}>
          <SheetContent
            side="right"
            className="flex w-[85vw] max-w-sm flex-col gap-0 p-0 sm:max-w-md md:max-w-lg"
            data-testid="mobile-members-sheet"
          >
            <SheetHeader>
              <SheetTitle>{tShell("memberSheetTitle")}</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* The same panel the desktop workbench shows — one roster, one
                  set of member actions. Opening a member's own chat navigates
                  away, so the sheet closes behind it. */}
              <TeamMembersPanel
                teamSessionId={activeSession?.id ?? null}
                teamId={activeSession?.teamId ?? null}
                onNavigated={() => setMemberSheetOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      {/* ── Cross-cutting dialogs (mirrored from DesktopChatWorkspace) ── */}
      <CharacterPicker
        open={characterPickerOpen}
        onOpenChange={setCharacterPickerOpen}
        onPick={async (c) => {
          const s = await create({
            title: tShell("directSessionTitle", { name: c.name }),
            kind: "direct",
            characterId: c.id,
          })
          select(s.id)
          setSelectedGuild({ kind: "dm" })
        }}
      />

      <MobileCommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onNewChat={handleNewDirect}
        onSelectSession={handleSwitchToSession}
        onOpenSettings={openSettings}
      />

      {/* Home-layout editor. Mounted by the shell rather than by the grid it
          edits, so the ⋮ entry can still reach it after every home section has
          been dismissed. */}
      <MobileHomeLayoutSheet open={homeLayoutOpen} onOpenChange={setHomeLayoutOpen} />
    </div>
  )
}
