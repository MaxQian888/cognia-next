"use client"

/**
 * Desktop Chat Workspace — the home-route content. Renders the Discord-style
 * channel/chat/member panes for DM and team guilds, swaps to the Canvas
 * editor for the canvas guild, and owns chat-domain modals (character
 * picker, onboarding, tool approval).
 *
 *   ┌ ChannelList │ ChatPane │ MemberList ┐    (DM / team guilds)
 *   └────────────────────────────────────┘
 *   ┌────────────── CanvasShell ─────────┐    (canvas guild)
 *   └────────────────────────────────────┘
 *
 * The global chrome (TitleBar, GuildRail, StatusBar, CommandPalette) is
 * provided by `DesktopAppShell` in the root layout — this component just
 * fills the shell's content slot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ChatPane } from "@/components/chat/chat-view"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/shell/member-list"
import { ArtifactPanel } from "@/components/artifacts/artifact-panel"
import { CanvasShell } from "@/components/canvas"
import { OnboardingDialog } from "@/components/shell/onboarding-dialog"
import { shouldShowOnboarding } from "@/lib/onboarding/should-show"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import { WorkspaceTrustGate } from "@/components/chat/workspace-trust-gate"
import type { ComposerHandle } from "@/components/chat/composer"
import type { ApprovalDecision, Character, SendContent } from "@/lib/claude/types"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { usePlatform } from "@/hooks/use-platform"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { markSessionRead } from "@/lib/db/session-state"
import { guildFromSession } from "@/lib/claude/guild"
import { loggers } from "@/lib/logging"

const log = loggers.shell

export function DesktopChatWorkspace() {
  const platform = usePlatform()
  const router = useRouter()
  const {
    sessions,
    isLoadingSessions,
    activeSessionId,
    select,
    create,
    remove,
    rename,
    bulkRemove,
    bulkSetPinned,
  } = useSessions()
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const pendingApproval = useChatStore((s) => s.pendingApprovals[0] ?? null)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  const composerRef = useRef<ComposerHandle | null>(null)

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
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

  useEffect(() => {
    if (!mounted) return
    const settings = useSettingsStore.getState().settings
    if (!settings) return
    let cancelled = false
    void shouldShowOnboarding(settings, sessions.length).then((show) => {
      if (cancelled || !show) return
      log.info("onboarding shown")
      setOnboardingOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [mounted, sessions.length])

  useEffect(() => {
    if (!mounted) return
    if (!activeSessionId) return
    if (selectedGuild.kind !== "team") return
    const current = sessions.find((s) => s.id === activeSessionId)
    if (!current) return
    if (current.kind === "team" && current.teamId === selectedGuild.teamId) return
    const target = guildFromSession(current)
    log.info("auto guild-switch from active session", {
      sessionId: current.id,
      target,
    })
    setSelectedGuild(target)
  }, [mounted, activeSessionId, sessions, selectedGuild, setSelectedGuild])

  useEffect(() => {
    if (!mounted) return
    if (activeSessionId) return
    const matching = sessions.find((s) => {
      if (selectedGuild.kind === "team") {
        return s.kind === "team" && s.teamId === selectedGuild.teamId
      }
      return s.kind !== "team"
    })
    if (matching) {
      log.info("auto-select session", { sessionId: matching.id })
      select(matching.id)
    }
  }, [mounted, activeSessionId, sessions, selectedGuild, select])

  useEffect(() => {
    if (errorMessage && errorMessage !== lastErrorShown) {
      log.warn("chat error surfaced", { message: errorMessage })
      toast.error(errorMessage)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastErrorShown(errorMessage)
    } else if (!errorMessage) {
      setLastErrorShown(null)
    }
  }, [errorMessage, lastErrorShown])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

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

  const openSettings = useCallback(
    (tab?: string) => {
      log.info("open settings", { tab: tab ?? "general" })
      router.push(tab ? `/settings?section=${tab}` : "/settings")
    },
    [router]
  )

  useEffect(() => {
    if (!pendingSettingsRequest) return
    log.info("open settings via deep-link", { tab: pendingSettingsRequest.tab })

    openSettings(pendingSettingsRequest.tab)
    clearPendingSettings()
  }, [pendingSettingsRequest, openSettings, clearPendingSettings])

  const handleNewDirect = useCallback(() => {
    log.info("new-direct (open character picker)")
    setCharacterPickerOpen(true)
  }, [])

  const handleNewTeamConversation = useCallback(
    async (teamId: string) => {
      log.info("new-team-conversation", { teamId })
      const s = await create({ title: "New conversation", kind: "team", teamId })
      select(s.id)
    },
    [create, select]
  )

  const handleSwitchToSession = useCallback(
    (id: string) => {
      log.info("switch-to-session", { sessionId: id })
      select(id)
      const target = sessions.find((s) => s.id === id)
      if (!target) return
      setSelectedGuild(guildFromSession(target))
    },
    [select, sessions, setSelectedGuild]
  )

  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)
  const isCanvasGuild = selectedGuild.kind === "canvas"

  const send = isTeamSession ? teamChat.send : directChat.send
  const stop = isTeamSession ? teamChat.stop : directChat.stop

  // Workspace Trust: bump a nonce on each send so the trust gate can lazily
  // prompt (once per session) when the active workspace is restricted. Trust
  // applies to direct chat — team sessions resolve cwd per-member elsewhere.
  const [trustPromptNonce, setTrustPromptNonce] = useState(0)
  const sendWithTrustPrompt = useCallback(
    (content: SendContent) => {
      if (!isTeamSession) setTrustPromptNonce((n) => n + 1)
      return send(content)
    },
    [send, isTeamSession]
  )

  const handleChannelNewDirect = useCallback(() => {
    void handleNewDirect()
  }, [handleNewDirect])

  const handleChannelNewTeam = useCallback(
    (id: string) => {
      void handleNewTeamConversation(id)
    },
    [handleNewTeamConversation]
  )

  const handleChannelDelete = useCallback(
    (id: string) => {
      void remove(id)
    },
    [remove]
  )

  const handleChannelRename = useCallback(
    (id: string, title: string) => {
      void rename(id, title)
    },
    [rename]
  )

  // `useTranslations` returns a fresh function reference on each render. Hold
  // it in a ref so the bulk callbacks (consumed by ChannelList) stay
  // referentially stable across renders and don't churn React Memo / effects.
  const bulkT = useTranslations("desktop.channelList.bulk")
  const bulkTRef = useRef(bulkT)
  useEffect(() => {
    bulkTRef.current = bulkT
  }, [bulkT])

  const handleChannelTogglePinned = useCallback(
    (id: string, pinned: boolean) => {
      void bulkSetPinned([id], pinned).then(() => {
        toast.success(bulkTRef.current(pinned ? "pinSuccess" : "unpinSuccess", { count: 1 }))
      })
    },
    [bulkSetPinned]
  )

  const handleChannelBulkDelete = useCallback(
    async (ids: string[]) => {
      const count = ids.length
      log.info("channel bulk-delete", { count })
      await bulkRemove(ids)
      toast.success(bulkTRef.current("deleteSuccess", { count }))
    },
    [bulkRemove]
  )

  const handleChannelBulkSetPinned = useCallback(
    async (ids: string[], pinned: boolean) => {
      const count = ids.length
      log.info("channel bulk-set-pinned", { count, pinned })
      await bulkSetPinned(ids, pinned)
      toast.success(bulkTRef.current(pinned ? "pinSuccess" : "unpinSuccess", { count }))
    },
    [bulkSetPinned]
  )

  const handleUseSample = useCallback(
    (text: string) => {
      void send(text)
    },
    [send]
  )

  const handleMemberMention = useCallback((c: Character) => {
    composerRef.current?.insertMention(c.name)
  }, [])

  const handleCharacterPick = useCallback(
    async (c: Character) => {
      log.info("character-picker pick", { characterId: c.id })
      const s = await create({
        title: `Chat with ${c.name}`,
        kind: "direct",
        characterId: c.id,
      })
      select(s.id)
      setSelectedGuild({ kind: "dm" })
    },
    [create, select, setSelectedGuild]
  )

  const handleOnboardingOpenChange = useCallback((open: boolean) => {
    setOnboardingOpen(open)
    if (!open) {
      log.info("onboarding dismissed")
    }
  }, [])

  const handleOnboardingPickCharacter = useCallback(
    async (c: Character) => {
      log.info("onboarding pick-character", { characterId: c.id })
      const s = await create({
        title: `Chat with ${c.name}`,
        kind: "direct",
        characterId: c.id,
      })
      select(s.id)
      setSelectedGuild({ kind: "dm" })
    },
    [create, select, setSelectedGuild]
  )

  const handleToolApprovalRespond = useCallback(
    (decision: ApprovalDecision) => {
      if (!pendingApproval) return Promise.resolve()
      return pendingApproval.sessionId.includes("::char::")
        ? teamChat.respondToApproval(pendingApproval, decision)
        : directChat.respondToApproval(pendingApproval, decision)
    },
    [pendingApproval, teamChat, directChat]
  )

  return (
    <>
      {isCanvasGuild ? (
        mounted ? (
          <CanvasShell />
        ) : null
      ) : (
        <>
          {!sidebarCollapsed && (
            <ChannelList
              sessions={sessions}
              loading={isLoadingSessions}
              activeSessionId={activeSessionId}
              onSelect={handleSwitchToSession}
              onNewDirect={handleChannelNewDirect}
              onNewTeamConversation={handleChannelNewTeam}
              onDelete={handleChannelDelete}
              onRename={handleChannelRename}
              onTogglePinned={handleChannelTogglePinned}
              onBulkDelete={handleChannelBulkDelete}
              onBulkSetPinned={handleChannelBulkSetPinned}
            />
          )}

          <main
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
            data-bg-target="chat"
          >
            {!mounted ? null : platform !== "tauri" ? (
              <DesktopOnlyBanner />
            ) : (
              <>
                {!isTeamSession && (
                  <WorkspaceTrustGate
                    sessionId={activeSession?.id ?? null}
                    promptNonce={trustPromptNonce}
                  />
                )}
                <ChatPane
                  activeSession={activeSession}
                  onSend={sendWithTrustPrompt}
                  onStop={stop}
                  onRegenerate={isTeamSession ? teamChat.regenerate : directChat.regenerate}
                  onEditResend={isTeamSession ? teamChat.editAndResend : directChat.editAndResend}
                  onCreate={handleNewDirect}
                  onUseSample={handleUseSample}
                  onOpenSettings={openSettings}
                  onNavigate={(href) => router.push(href)}
                  recentSessions={recentSessions}
                  onResumeSession={handleSwitchToSession}
                  composerRef={composerRef}
                />
              </>
            )}
          </main>

          {isTeamSession && (
            <MemberList
              teamSessionId={activeSession?.id ?? null}
              teamId={activeSession?.teamId ?? null}
              onMention={handleMemberMention}
            />
          )}
          <ArtifactPanel />
        </>
      )}

      <CharacterPicker
        open={characterPickerOpen}
        onOpenChange={setCharacterPickerOpen}
        onPick={handleCharacterPick}
      />

      <OnboardingDialog
        open={onboardingOpen}
        onOpenChange={handleOnboardingOpenChange}
        onPickCharacter={handleOnboardingPickCharacter}
      />

      <ToolApprovalDialog approval={pendingApproval} onRespond={handleToolApprovalRespond} />
    </>
  )
}

function DesktopOnlyBanner() {
  const t = useTranslations("desktop.shell")
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h2 className="text-xl font-semibold">{t("desktopOnlyTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("desktopOnlyBodyPrefix")}
          <code className="rounded bg-muted px-1 py-0.5">pnpm tauri dev</code>
          {t("desktopOnlyBodyMiddle")}
          <code className="rounded bg-muted px-1 py-0.5">pnpm dev</code>
          {t("desktopOnlyBodySuffix")}
        </p>
      </div>
    </div>
  )
}
