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

import { ChatPaneGroup } from "@/components/chat/chat-pane-group"
import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/shell/member-list"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
import { CanvasShell } from "@/components/canvas/canvas-shell"
import { OnboardingDialog } from "@/components/shell/onboarding-dialog"
import { shouldShowOnboarding } from "@/lib/onboarding/should-show"
import { WorkspaceTrustGate } from "@/components/chat/workspace-trust-gate"
import type { ComposerHandle } from "@/components/chat/composer"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type {
  ApprovalDecision,
  Character,
  PendingApproval,
  SendContent,
} from "@cognia/agent-config-types"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { usePlatform } from "@/hooks/use-platform"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { markSessionRead } from "@/lib/db/session-state"
import { updateSession, setSessionOrder } from "@/lib/db/sessions"
import { guildFromSession } from "@/lib/claude/guild"
import { planGuildReconcile } from "@/lib/shell/guild-session-sync"
import { loggers } from "@cognia/logging"

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
  const activeSessionEpoch = useChatStore((s) => s.activeSessionEpoch)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const selectedGuildEpoch = useUIStore((s) => s.selectedGuildEpoch)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)

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
  // touched most recently wins. A deliberate team click in the rail resumes
  // that team's most recent conversation; a team with no conversations lands
  // on the welcome empty state (the CTA / "+" create one explicitly — the
  // reconcile never silently inserts a session row). A session resumed from
  // elsewhere still pulls the guild over to match it.
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
    }
  }, [
    mounted,
    selectedGuild,
    selectedGuildEpoch,
    activeSessionEpoch,
    sessions,
    activeSessionId,
    select,
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
      return s
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

  // Kind lookup for the per-pane dispatchers below: a team session routes to
  // useTeamChat, everything else to useClaudeChat. Both hooks are session-
  // parameterized, so team and direct panes share one ChatPaneGroup.
  const isTeamSessionId = useCallback(
    (sid: string) => {
      const s = sessions.find((x) => x.id === sid)
      return s?.kind === "team" && Boolean(s.teamId)
    },
    [sessions]
  )

  // Workspace Trust: bump a nonce on each send so the trust gate can lazily
  // prompt (once per session) when the active workspace is restricted. The
  // gate applies to team sessions too — a member's cwd resolves through the
  // same session.workingDir → workspace root chain as direct chat.
  const [trustPromptNonce, setTrustPromptNonce] = useState(0)

  // Per-session handlers for the concurrent chat panes. Each binds to an
  // explicit session id so a background pane sends / stops / regenerates
  // against itself. Trust-prompting wraps the send for the targeted pane.
  const paneSend = useCallback(
    (content: SendContent, sid: string, manifest?: readonly AttachmentManifestEntry[]) => {
      setTrustPromptNonce((n) => n + 1)
      return isTeamSessionId(sid)
        ? teamChat.send(content, { sessionId: sid, attachmentManifest: manifest })
        : directChat.send(content, undefined, {
            sessionId: sid,
            attachmentManifest: manifest,
          })
    },
    [directChat, teamChat, isTeamSessionId]
  )
  const paneStop = useCallback(
    (sid: string) => (isTeamSessionId(sid) ? teamChat.stop(sid) : directChat.stop(sid)),
    [directChat, teamChat, isTeamSessionId]
  )
  const paneSteer = useCallback(
    (sid: string) =>
      isTeamSessionId(sid) ? teamChat.interruptAndSteer(sid) : directChat.interruptAndSteer(sid),
    [directChat, teamChat, isTeamSessionId]
  )
  const paneFlush = useCallback(
    (sid: string) => (isTeamSessionId(sid) ? teamChat.flushSteer(sid) : directChat.flushSteer(sid)),
    [directChat, teamChat, isTeamSessionId]
  )
  const paneRegenerate = useCallback(
    (sid: string) => (isTeamSessionId(sid) ? teamChat.regenerate(sid) : directChat.regenerate(sid)),
    [directChat, teamChat, isTeamSessionId]
  )
  const paneEditResend = useCallback(
    (messageId: string, content: SendContent, sid: string) =>
      isTeamSessionId(sid)
        ? teamChat.editAndResend(messageId, content, sid)
        : directChat.editAndResend(messageId, content, sid),
    [directChat, teamChat, isTeamSessionId]
  )
  const paneClose = useCallback(
    (sid: string) => {
      // Team sub-sessions are torn down per turn by useTeamChat; closing the
      // pane only drops the store slice. Direct panes also close the sidecar
      // session.
      if (isTeamSessionId(sid)) useChatStore.getState().closeSession(sid)
      else void directChat.close(sid)
    },
    [directChat, isTeamSessionId]
  )

  // After a plan is approved in the plan-approval dock, switch the session's
  // permission mode and resume the turn. The store mode is set FIRST (so the
  // composer's persist effect can't clobber the row back to `plan`), the row is
  // then written authoritatively and AWAITED before `send` — `send` resolves the
  // mode from the session row, not the store, so a stale row would run the resume
  // turn in `plan` mode. `skipUserAppend` injects the turn with no user bubble.
  const resumeAfterPlanApproval = useCallback(
    async (prompt: string, mode: PlanResumeMode, sid: string) => {
      // Plan mode is a direct-chat surface (principled exclusion for teams).
      if (isTeamSessionId(sid)) return
      if (useChatStore.getState().activeSessionId === sid) {
        useChatStore.getState().setPermissionMode(mode)
      }
      await updateSession(sid, { permissionMode: mode })
      await directChat.send(prompt, undefined, { sessionId: sid, skipUserAppend: true })
    },
    [directChat, isTeamSessionId]
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

  const handleReorderSessions = useCallback((ids: string[], sectionKey: string) => {
    void setSessionOrder(ids, sectionKey)
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

  // Starter cards / follow-up chips. On the welcome page there is no session
  // yet, so this has to start one before sending: `send` drops the prompt when
  // no session is selected, which made the cards read as dead buttons. The new
  // session is addressed explicitly — the store pointer has not propagated to
  // this closure yet.
  const handleUseSample = useCallback(
    async (text: string) => {
      const active = useChatStore.getState().activeSessionId
      if (active) {
        if (isTeamSessionId(active)) await teamChat.send(text, { sessionId: active })
        else await directChat.send(text, undefined, { sessionId: active })
        return
      }
      // Quick-start respects the selected guild, same as the welcome CTA. A
      // bare `create()` auto-applies the default preset, so a direct
      // quick-start needs no character pick.
      if (selectedGuild.kind === "team") {
        const s = await handleNewTeamConversation(selectedGuild.teamId)
        await teamChat.send(text, { sessionId: s.id })
      } else {
        const s = await create()
        await directChat.send(text, undefined, { sessionId: s.id })
      }
    },
    [directChat, teamChat, isTeamSessionId, create, selectedGuild, handleNewTeamConversation]
  )

  // The welcome CTA / tab-strip "+" respect the selected guild: a team guild
  // starts a new conversation with that team, everything else opens the
  // character picker for a direct chat.
  const handleCreate = useCallback(() => {
    if (selectedGuild.kind === "team") void handleNewTeamConversation(selectedGuild.teamId)
    else handleNewDirect()
  }, [selectedGuild, handleNewTeamConversation, handleNewDirect])

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

  // Inline pane gates carry approvals for both kinds; team approvals arrive
  // tagged with the member sub-session id, so route them to useTeamChat.
  const handleApprovalRespond = useCallback(
    (approval: PendingApproval, decision: ApprovalDecision) =>
      decodeSubSession(approval.sessionId) !== null
        ? teamChat.respondToApproval(approval, decision)
        : directChat.respondToApproval(approval, decision),
    [teamChat, directChat]
  )

  return (
    <>
      {isCanvasGuild ? (
        mounted ? (
          <CanvasShell />
        ) : null
      ) : (
        <>
          {/* Always mounted so the rail can animate its width to 0 when
              collapsed (a smooth transition needs the element to stay in the
              DOM). It self-hides to a 0-width column — no leftover strip — and
              is restored from the chat-header toggle. State is the single
              `sidebarCollapsed` store field shared with the title/status bars,
              View menu, and ⌘B. */}
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
            onReorderSessions={handleReorderSessions}
          />

          <ArtifactWorkspaceDock>
            <main
              className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
              data-bg-target="chat"
            >
              {!mounted ? null : platform !== "tauri" ? (
                <DesktopOnlyBanner />
              ) : (
                <>
                  <WorkspaceTrustGate
                    sessionId={activeSession?.id ?? null}
                    promptNonce={trustPromptNonce}
                  />
                  {/* Concurrent chat workspace (direct AND team sessions):
                    tabs + optional split, each pane bound to its own session
                    slice + inline approval gate, dispatched by session kind. */}
                  <ChatPaneGroup
                    sessions={sessions}
                    send={paneSend}
                    stop={paneStop}
                    steerNow={paneSteer}
                    steerFlush={paneFlush}
                    regenerate={paneRegenerate}
                    editResend={paneEditResend}
                    respondToApproval={handleApprovalRespond}
                    closePane={paneClose}
                    onCreate={handleCreate}
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
          {/* i18n-exempt: literal shell command */}
          <code className="rounded bg-muted px-1 py-0.5">pnpm tauri dev</code>
          {t("desktopOnlyBodyMiddle")}
          {/* i18n-exempt: literal shell command */}
          <code className="rounded bg-muted px-1 py-0.5">pnpm dev</code>
          {t("desktopOnlyBodySuffix")}
        </p>
      </div>
    </div>
  )
}
