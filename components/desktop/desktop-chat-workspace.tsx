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
import { ChatPaneGroup } from "@/components/chat/chat-pane-group"
import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/shell/member-list"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
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
import { updateSession, setPinnedOrder } from "@/lib/db/sessions"
import { guildFromSession } from "@/lib/claude/guild"
import { planGuildReconcile } from "@/lib/shell/guild-session-sync"
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
    archive,
    unarchive,
    bulkArchive,
    bulkUnarchive,
    folders,
    createFolder,
    renameFolder,
    deleteFolder,
    assignToFolder,
  } = useSessions()
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const pendingApproval = useChatStore((s) => s.pendingApprovals[0] ?? null)
  const activeSessionEpoch = useChatStore((s) => s.activeSessionEpoch)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const selectedGuildEpoch = useUIStore((s) => s.selectedGuildEpoch)
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

  // Keep the active chat session in lockstep with the selected guild. The two
  // live in separate stores (guild in useUIStore, session in useChatStore), so
  // when they disagree we reconcile by navigation epoch: whichever the user
  // touched most recently wins. This is what makes a deliberate team click in
  // the rail open that team's conversation — resuming the most recent one, or
  // starting a fresh one when the team has none — instead of bouncing back to a
  // "pick a team" screen, while a session resumed from elsewhere still pulls
  // the guild over to match it.
  const creatingTeamRef = useRef<string | null>(null)
  useEffect(() => {
    if (!mounted) return
    const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null
    const action = planGuildReconcile({
      guild: selectedGuild,
      guildWins: selectedGuildEpoch > activeSessionEpoch,
      activeSession,
      sessions,
    })
    switch (action.type) {
      case "none":
        break
      case "select":
        log.info("auto-select session", { sessionId: action.sessionId })
        select(action.sessionId)
        break
      case "clear":
        select(null)
        break
      case "sync-guild":
        log.info("auto guild-switch from active session", { target: action.guild })
        setSelectedGuild(action.guild)
        break
      case "create-team": {
        const { teamId } = action
        // Guard the async gap: the live session list and active id only update
        // after create() resolves, so without this the effect could fire a
        // second create before the first one lands.
        if (creatingTeamRef.current === teamId) break
        creatingTeamRef.current = teamId
        log.info("new-team-conversation", { teamId, reason: "guild-switch" })
        void create({ title: "New conversation", kind: "team", teamId })
          .then((s) => select(s.id))
          .catch((err) =>
            log.warn("new-team-conversation failed", {
              teamId,
              error: err instanceof Error ? err.message : String(err),
            })
          )
          .finally(() => {
            if (creatingTeamRef.current === teamId) creatingTeamRef.current = null
          })
        break
      }
    }
  }, [
    mounted,
    selectedGuild,
    selectedGuildEpoch,
    activeSessionEpoch,
    sessions,
    activeSessionId,
    select,
    create,
    setSelectedGuild,
  ])

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

  // Per-session handlers for the concurrent direct-chat panes. Each binds to an
  // explicit session id so a background pane sends / stops / regenerates
  // against itself. Trust-prompting wraps the send for the targeted pane.
  const paneSend = useCallback(
    (content: SendContent, sid: string) => {
      setTrustPromptNonce((n) => n + 1)
      return directChat.send(content, undefined, { sessionId: sid })
    },
    [directChat]
  )
  const paneStop = useCallback((sid: string) => directChat.stop(sid), [directChat])
  const paneSteer = useCallback((sid: string) => directChat.interruptAndSteer(sid), [directChat])
  const paneFlush = useCallback((sid: string) => directChat.flushSteer(sid), [directChat])
  const paneRegenerate = useCallback((sid: string) => directChat.regenerate(sid), [directChat])
  const paneEditResend = useCallback(
    (messageId: string, content: SendContent, sid: string) =>
      directChat.editAndResend(messageId, content, sid),
    [directChat]
  )
  const paneClose = useCallback((sid: string) => void directChat.close(sid), [directChat])

  // After a plan is approved in the plan-approval dock, switch the session's
  // permission mode and resume the turn. The store mode is set FIRST (so the
  // composer's persist effect can't clobber the row back to `plan`), the row is
  // then written authoritatively and AWAITED before `send` — `send` resolves the
  // mode from the session row, not the store, so a stale row would run the resume
  // turn in `plan` mode. `skipUserAppend` injects the turn with no user bubble.
  const resumeAfterPlanApproval = useCallback(
    async (prompt: string, mode: PlanResumeMode, sid: string) => {
      if (useChatStore.getState().activeSessionId === sid) {
        useChatStore.getState().setPermissionMode(mode)
      }
      await updateSession(sid, { permissionMode: mode })
      await directChat.send(prompt, undefined, { sessionId: sid, skipUserAppend: true })
    },
    [directChat]
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

  const handleReorderPinned = useCallback((ids: string[]) => {
    void setPinnedOrder(ids)
  }, [])

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

  const handleChannelBulkArchive = useCallback(
    async (ids: string[]) => {
      const count = ids.length
      log.info("channel bulk-archive", { count })
      await bulkArchive(ids)
      toast.success(bulkTRef.current("archiveSuccess", { count }))
    },
    [bulkArchive]
  )

  const handleChannelBulkUnarchive = useCallback(
    async (ids: string[]) => {
      const count = ids.length
      log.info("channel bulk-unarchive", { count })
      await bulkUnarchive(ids)
      toast.success(bulkTRef.current("unarchiveSuccess", { count }))
    },
    [bulkUnarchive]
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
              onArchive={archive}
              onUnarchive={unarchive}
              onBulkDelete={handleChannelBulkDelete}
              onBulkSetPinned={handleChannelBulkSetPinned}
              onBulkArchive={handleChannelBulkArchive}
              onBulkUnarchive={handleChannelBulkUnarchive}
              folders={folders}
              onCreateFolder={createFolder}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onAssignToFolder={assignToFolder}
              onReorderPinned={handleReorderPinned}
            />
          )}

          <ArtifactWorkspaceDock>
            <main
              className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
              data-bg-target="chat"
            >
              {!mounted ? null : platform !== "tauri" ? (
                <DesktopOnlyBanner />
              ) : isTeamSession ? (
                // Team sessions stay single-pane (per-member sub-sessions are
                // orchestrated by useTeamChat); no multi-pane tabs.
                <ChatPane
                  activeSession={activeSession}
                  onSend={sendWithTrustPrompt}
                  onStop={stop}
                  onRegenerate={teamChat.regenerate}
                  onEditResend={teamChat.editAndResend}
                  onCreate={handleNewDirect}
                  onUseSample={handleUseSample}
                  onOpenSettings={openSettings}
                  recentSessions={recentSessions}
                  onResumeSession={handleSwitchToSession}
                  composerRef={composerRef}
                />
              ) : (
                <>
                  <WorkspaceTrustGate
                    sessionId={activeSession?.id ?? null}
                    promptNonce={trustPromptNonce}
                  />
                  {/* Concurrent direct-chat workspace: tabs + optional split, each
                    pane bound to its own session slice + inline approval gate. */}
                  <ChatPaneGroup
                    sessions={sessions}
                    send={paneSend}
                    stop={paneStop}
                    steerNow={paneSteer}
                    steerFlush={paneFlush}
                    regenerate={paneRegenerate}
                    editResend={paneEditResend}
                    respondToApproval={directChat.respondToApproval}
                    closePane={paneClose}
                    onCreate={handleNewDirect}
                    onUseSample={handleUseSample}
                    onOpenSettings={openSettings}
                    recentSessions={recentSessions}
                    onResumeSession={handleSwitchToSession}
                    composerRef={composerRef}
                    onResumeAfterPlanApproval={resumeAfterPlanApproval}
                  />
                </>
              )}
            </main>
          </ArtifactWorkspaceDock>

          {isTeamSession && (
            <MemberList
              teamSessionId={activeSession?.id ?? null}
              teamId={activeSession?.teamId ?? null}
              onMention={handleMemberMention}
            />
          )}
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

      {/* Team sessions surface approvals through this single dialog; direct
          sessions render per-pane inline gates inside ChatPaneGroup. */}
      {isTeamSession && (
        <ToolApprovalDialog approval={pendingApproval} onRespond={handleToolApprovalRespond} />
      )}
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
