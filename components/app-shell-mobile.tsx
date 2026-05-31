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

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  MenuIcon,
  MoreVerticalIcon,
  SearchIcon,
  SettingsIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ChatPane } from "@/components/chat/chat-view"
import { CharacterPicker } from "@/components/chat/character-picker"
import { GuildRail } from "@/components/shell/guild-rail"
import { MemberList } from "@/components/shell/member-list"
import { OnboardingDialog } from "@/components/shell/onboarding-dialog"
import { shouldShowOnboarding } from "@/lib/onboarding/should-show"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import { CharacterHeader } from "@/components/mobile/shell/character-header"
import { MobileChannelList } from "@/components/mobile/shell/mobile-channel-list"
import { MobileQuickActions } from "@/components/mobile/home/mobile-quick-actions"
import { MobileActiveRunsCard } from "@/components/mobile/home/mobile-active-runs-card"
import { MobileCommandPalette } from "@/components/mobile/home/mobile-command-palette"
import { useMobileHomeLayout } from "@/components/mobile/home/use-mobile-home-layout"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ComposerHandle } from "@/components/chat/composer"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useTeamMembers } from "@/hooks/use-team-members"
import { useClientLiveQuery } from "@/hooks/data"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { whenSeeded } from "@/lib/db/schema"
import { markSessionRead } from "@/lib/db/session-state"
import { listCharacters } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"
import { guildFromSession } from "@/lib/claude/guild"
import { loggers } from "@/lib/logging"
import type { Character, Team } from "@/lib/claude/types"

const log = loggers.shell

export function AppShellMobile() {
  const t = useTranslations("desktop.shell")
  const tShell = useTranslations("mobile.shell")
  const router = useRouter()
  const { sessions, activeSessionId, select, create, remove } = useSessions()
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const chatStatus = useChatStore((s) => s.status)
  const pendingApproval = useChatStore((s) => s.pendingApprovals[0] ?? null)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)
  const { isSectionHidden } = useMobileHomeLayout()

  const [navOpen, setNavOpen] = useState(false)
  const [memberSheetOpen, setMemberSheetOpen] = useState(false)
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
  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)
  const teamMembers = useTeamMembers(isTeamSession ? activeSession?.teamId : null)

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

  const send = isTeamSession ? teamChat.send : directChat.send
  const stop = isTeamSession ? teamChat.stop : directChat.stop
  const respondToApproval = (
    approval: typeof pendingApproval,
    decision: Parameters<typeof directChat.respondToApproval>[1]
  ) => {
    if (!approval) return Promise.resolve()
    return approval.sessionId.includes("::char::")
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
      className="relative flex h-[100dvh] w-full flex-col bg-background text-foreground safe-area-pt"
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

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
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

      {/* ── Chat pane (single column) ─────────────────────────────────── */}
      <main
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden safe-area-pb"
        data-bg-target="chat"
      >
        {!mounted ? null : (
          <ChatPane
            activeSession={activeSession}
            onSend={send}
            onStop={stop}
            onRegenerate={isTeamSession ? teamChat.regenerate : directChat.regenerate}
            onEditResend={isTeamSession ? teamChat.editAndResend : directChat.editAndResend}
            onCreate={handleNewDirect}
            onUseSample={(text) => void send(text)}
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
