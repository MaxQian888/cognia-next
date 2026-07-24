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
  KeyRoundIcon,
  MenuIcon,
  MoreVerticalIcon,
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
import { CharacterPicker } from "@/components/chat/character-picker"
import { GuildRail } from "@/components/shell/guild-rail"
import { MemberList } from "@/components/shell/member-list"
import { OnboardingDialog } from "@/components/shell/onboarding-dialog"
import { shouldShowOnboarding } from "@/lib/onboarding/should-show"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import { CharacterHeader } from "@/components/mobile/shell/character-header"
import { MobileWorkspaceChip } from "@/components/mobile/shell/mobile-workspace-chip"
import { MobileChannelList } from "@/components/mobile/shell/mobile-channel-list"
import { SingleExportDialog } from "@/components/data/export/single-export-dialog"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { MobileQuickActions } from "@/components/mobile/home/mobile-quick-actions"
import { MobileActiveRunsCard } from "@/components/mobile/home/mobile-active-runs-card"
import { MobileCommandPalette } from "@/components/mobile/home/mobile-command-palette"
import { useMobileHomeLayout } from "@/components/mobile/home/use-mobile-home-layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ComposerHandle } from "@/components/chat/composer"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { useTeamMembers } from "@/hooks/use-team-members"
import { useClientLiveQuery } from "@/hooks/data"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { getDb, whenSeeded } from "@/lib/db/schema"
import { markSessionRead } from "@/lib/db/session-state"
import { updateSession } from "@/lib/db/sessions"
import { listCharacters } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"
import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import { guildFromSession } from "@/lib/claude/guild"
import { loggers } from "@cognia/logging"
import type { Character, SendContent, Team } from "@cognia/agent-config-types"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { impact, notify } from "@/lib/capacitor/haptics"

const log = loggers.shell

export function AppShellMobile() {
  const t = useTranslations("desktop.shell")
  const tShell = useTranslations("mobile.shell")
  const router = useRouter()
  const { sessions, activeSessionId, select, create, remove, rename, archive, unarchive, folders } =
    useSessions()
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const chatStatus = useChatStore((s) => s.status)
  const pendingApproval = useChatStore((s) => s.pendingApprovals[0] ?? null)

  const loadSettings = useSettingsStore((s) => s.load)
  const lastInboxViewedAt = useSettingsStore((s) => s.settings?.lastInboxViewedAt ?? 0)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)
  const { isSectionHidden } = useMobileHomeLayout()

  const { keyOk } = useCredentialStatus()

  const [navOpen, setNavOpen] = useState(false)
  const [memberSheetOpen, setMemberSheetOpen] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)

  const composerRef = useRef<ComposerHandle | null>(null)

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

  useEffect(() => {
    if (!activeSessionId) return
    void markSessionRead(activeSessionId).catch((err) => {
      log.warn("markSessionRead failed", {
        sessionId: activeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, [activeSessionId])

  // Onboarding nudge — same trigger as desktop.
  useEffect(() => {
    if (!mounted) return
    const settings = useSettingsStore.getState().settings
    if (!settings) return
    let cancelled = false
    void shouldShowOnboarding(settings, sessions.length).then((show) => {
      if (cancelled || !show) return
      log.info("onboarding shown (mobile)")
      setOnboardingOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [mounted, sessions.length])

  // Auto-select most recent session matching the current guild.
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
    const matching = sessions.find((s) => {
      if (selectedGuild.kind === "team") {
        return s.kind === "team" && s.teamId === selectedGuild.teamId
      }
      return s.kind !== "team"
    })
    if (matching) {
      select(matching.id)
    }
  }, [mounted, sessions, activeSessionId, selectedGuild, select, setSelectedGuild])

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
  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)
  const teamMembers = useTeamMembers(isTeamSession ? activeSession?.teamId : null)

  const inboxUnread = useClientLiveQuery<number>(
    () => getDb().inboundLedger.where("receivedAt").above(lastInboxViewedAt).count(),
    [lastInboxViewedAt],
    0
  )

  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
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
    async (content: SendContent, manifest?: readonly AttachmentManifestEntry[]) => {
      try {
        if (isTeamSession) {
          await teamChat.send(content, { attachmentManifest: manifest })
        } else {
          await directChat.send(content, undefined, { attachmentManifest: manifest })
        }
        void impact("light")
      } catch (err) {
        void notify("error")
        throw err
      }
    },
    [directChat, isTeamSession, teamChat]
  )
  // Resume the turn after a plan is approved in the mobile PlanApprovalDock.
  // Mirrors `desktop-chat-workspace.resumeAfterPlanApproval`: set the store
  // mode first (so the composer's persist effect can't clobber the row back
  // to `plan`), write the session row authoritatively and AWAIT it before
  // `send` (which resolves the mode from the row), and inject the resume turn
  // with no user bubble. Plan mode is a direct-chat surface, so teams are
  // excluded — the dock only renders here for the active bound session, so the
  // active id IS the plan's session.
  const resumeAfterPlanApproval = useCallback(
    async (prompt: string, mode: PlanResumeMode) => {
      const sid = activeSessionId
      if (!sid || isTeamSession) return
      useChatStore.getState().setPermissionMode(mode)
      await updateSession(sid, { permissionMode: mode })
      await directChat.send(prompt, undefined, { sessionId: sid, skipUserAppend: true })
    },
    [activeSessionId, isTeamSession, directChat]
  )
  const respondToApproval = (
    approval: typeof pendingApproval,
    decision: Parameters<typeof directChat.respondToApproval>[1]
  ) => {
    if (!approval) return Promise.resolve()
    return decodeSubSession(approval.sessionId) !== null
      ? teamChat.respondToApproval(approval, decision)
      : directChat.respondToApproval(approval, decision)
  }

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

  const handleNewDirect = () => setCharacterPickerOpen(true)

  const handleCreateTeam = () => openSettings("teams")

  const handleSwitchToSession = (id: string) => {
    select(id)
    const target = sessions.find((s) => s.id === id)
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
      className="relative flex h-[100dvh] w-full flex-col bg-background text-foreground safe-area-pt safe-area-px"
      data-testid="app-shell-mobile"
    >
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header
        className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2"
        data-app-chrome
      >
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
            className="flex w-[85vw] max-w-sm flex-col gap-0 p-0 sm:max-w-md md:max-w-lg"
            data-testid="mobile-nav-sheet"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{tShell("navSheetTitle")}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-1 overflow-hidden">
              <GuildRail
                onCreateTeam={handleCreateTeam}
                onOpenSettings={() => {
                  setNavOpen(false)
                  openSettings()
                }}
              />
              <div className="flex flex-1 overflow-hidden">
                <MobileChannelList
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelect={handleSwitchToSession}
                  onNewDirect={() => {
                    setNavOpen(false)
                    handleNewDirect()
                  }}
                  onDelete={(id) => void remove(id)}
                  onRename={(id, title) => void rename(id, title)}
                  onArchive={(id) => void archive(id)}
                  onUnarchive={(id) => void unarchive(id)}
                  folders={folders}
                />
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <CharacterHeader
          subject={headerSubject}
          fallbackTitle={headerTitle}
          streaming={chatStatus === "streaming"}
        />

        <MobileWorkspaceChip className="ml-2 shrink-0" />

        {/* Missing-credential warning stays visible (blocking issue): a tap
            opens the session sheet whose Account section resolves it. Never
            buried in the overflow menu. */}
        {keyOk === false && activeSession ? (
          <Badge
            variant="destructive"
            className="ml-2 shrink-0 cursor-pointer gap-1"
            onClick={() => setSessionSettingsOpen(true)}
            data-testid="mobile-no-api-key"
          >
            <KeyRoundIcon className="size-3" />
            {tShell("noApiKey")}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
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
                className="touch-target"
                aria-label={tShell("sessionMenu")}
                data-testid="mobile-actions-trigger"
              >
                <MoreVerticalIcon className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleNewDirect} data-testid="mobile-action-new-chat">
                <UserPlusIcon className="size-4" />
                <span>{tShell("newChat")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
        // Reserve the fixed <MobileTabBar /> footprint (h-14 + its own
        // safe-area inset) so the composer's bottom toolbar row isn't hidden
        // behind it. The shell root is `h-[100dvh]`, which overrides the
        // MobileShellWrapper's `pb` reservation, so we re-assert it here. This
        // calc already includes env(safe-area-inset-bottom), superseding the
        // bare `safe-area-pb` that only cleared the home indicator.
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]"
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
              // Plan-mode approval dock — direct-chat only (teams never enter
              // plan mode). Without this a plan awaiting approval stranded the
              // turn on mobile: the composer can enter plan mode but the dock
              // never rendered.
              onResumeAfterPlanApproval={isTeamSession ? undefined : resumeAfterPlanApproval}
              onCreate={handleNewDirect}
              onUseSample={(text) => void handleSend(text)}
              onOpenSettings={openSettings}
              recentSessions={isSectionHidden("recents") ? undefined : recentSessions}
              onResumeSession={handleSwitchToSession}
              composerRef={composerRef}
              mobileMentionMembers={isTeamSession ? teamMembers : undefined}
              welcomeExtras={{
                hideSamples: true,
                header: <MobileActiveRunsCard />,
                quickActions: (
                  <MobileQuickActions
                    onNewChat={handleNewDirect}
                    onSearch={() => setSearchOpen(true)}
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
            <div className="flex flex-1 overflow-hidden">
              <MemberList
                teamSessionId={activeSession?.id ?? null}
                teamId={activeSession?.teamId ?? null}
                onMention={(c) => {
                  composerRef.current?.insertMention(c.name)
                  setMemberSheetOpen(false)
                }}
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

      <OnboardingDialog
        open={onboardingOpen}
        onOpenChange={(open) => {
          setOnboardingOpen(open)
        }}
        onPickCharacter={async (c) => {
          const s = await create({
            title: tShell("directSessionTitle", { name: c.name }),
            kind: "direct",
            characterId: c.id,
          })
          select(s.id)
          setSelectedGuild({ kind: "dm" })
        }}
      />

      <ToolApprovalDialog
        approval={pendingApproval}
        onRespond={(decision) =>
          pendingApproval ? respondToApproval(pendingApproval, decision) : Promise.resolve()
        }
      />

      <MobileCommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onNewChat={handleNewDirect}
        onSelectSession={handleSwitchToSession}
        onOpenSettings={openSettings}
      />
    </div>
  )
}
