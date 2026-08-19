"use client"

/**
 * Desktop Chat Workspace — the home-route content. Renders the Discord-style
 * channel/chat/member panes for DM and team guilds, swaps to the Canvas
 * editor for the canvas guild, and owns chat-domain modals (character
 * picker, onboarding, tool approval).
 *
 *   ┌ ChannelList │ ChatPane │ ContextWorkbench ┐  (DM / team guilds)
 *   └──────────────────────────────────────────┘
 *
 * A team session's roster is not a column of its own any more: it is the
 * workbench's `team-members` panel (`chat-dock-panels.tsx`).
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
import { Button } from "@/components/ui/button"
import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ChannelList } from "@/components/desktop/channel-list"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
import { TitleBarProjectionScope } from "@/components/shell/title-bar-outlets"
import { CanvasShell } from "@/components/canvas/canvas-shell"
import { WorkspaceTrustGate } from "@/components/chat/workspace-trust-gate"
import type { ComposerHandle } from "@/components/chat/composer"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type {
  ApprovalDecision,
  Character,
  PendingApproval,
  SendContent,
} from "@cognia/agent-config-types"
import { onComposerMentionRequest } from "@/lib/chat/composer-mention-request"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { useUIStore } from "@/stores/ui"
import { markSessionRead } from "@/lib/db/session-state"
import { updateSession, setSessionOrder } from "@/lib/db/sessions"
import { guildFromSession } from "@/lib/claude/guild"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import { useProjectStore } from "@/stores/project/project-store"
import { planGuildReconcile } from "@/lib/shell/guild-session-sync"
import { loggers } from "@cognia/logging"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { usePlatform } from "@/hooks/use-platform"
import {
  resolveOperationAvailability,
  type OperationAvailabilityState,
} from "@/lib/runtime/operation-availability"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"

const log = loggers.shell

export function DesktopChatWorkspace() {
  const router = useRouter()
  const platform = usePlatform()
  const runtimeT = useTranslations("desktop.chatRuntime")
  const tMembers = useTranslations("desktop.memberList")
  const runtimeSnapshot = useRuntimeSnapshot()
  const chatAvailability = resolveOperationAvailability({
    snapshot: runtimeSnapshot,
    command: "claude_send",
    localExecutorAvailable: runtimeSnapshot.target?.kind === "standalone",
    readOnlyFallback: true,
  })
  const composerDisabled = chatAvailability.state !== "available"
  const runtimeRecovery = resolveRuntimeRecovery(chatAvailability, platform)
  // Grouping by workspace is the one mode that needs conversations from every
  // workspace; every other mode keeps the sidebar workspace-isolated.
  const sidebarGroupBy = resolveConversationGroupBy(
    useSettingsStore((s) => s.settings?.conversationSidebar)
  )
  const {
    sessions,
    isLoadingSessions,
    activeSessionId,
    activeSession,
    activeSessionState,
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
    reorderFolders,
    assignToFolder,
  } = useSessions({ crossWorkspace: sidebarGroupBy === "workspace" })
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const activeSessionEpoch = useChatStore((s) => s.activeSessionEpoch)

  const loadSettings = useSettingsStore((s) => s.load)
  // Which edge the conversation sidebar takes. The nav rail already follows
  // this preference (`desktop-app-shell.tsx`); the sidebar sits beside it, so
  // both chat columns stay on the chosen side instead of the navigation
  // jumping to the other one whenever the user lands on `/`.
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const selectedGuildEpoch = useUIStore((s) => s.selectedGuildEpoch)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)

  // The sidebar may list every workspace, but guild reconciliation must only
  // resume conversations from the workspace that owns the chat pane. Otherwise
  // an absent foreign active id is selected again on every navigation-epoch
  // update, producing a maximum-update-depth loop.
  const guildSessions = useMemo(
    () =>
      activeProjectId
        ? sessions.filter((session) => !session.projectId || session.projectId === activeProjectId)
        : sessions,
    [sessions, activeProjectId]
  )

  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)

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
    const action = planGuildReconcile({
      guild: selectedGuild,
      guildWins: selectedGuildEpoch > activeSessionEpoch,
      activeSession,
      // `useSessions` resolves the active id against Dexie, not against the
      // (eventually-consistent) list, so a conversation that was just created
      // reconciles as itself instead of looking deleted for a render.
      activeSessionPending: activeSessionState === "pending",
      sessions: guildSessions,
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
    guildSessions,
    activeSession,
    activeSessionState,
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
  }, [setCharacterPickerOpen])

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
      const target = sessions.find((s) => s.id === id)
      // Follow the conversation into its workspace *before* focusing it. Under
      // `groupBy: "workspace"` the list spans every workspace, and everything
      // downstream of the chat pane — artifacts, terminals, the workspace panel,
      // memories — resolves against `activeProjectId`. Selecting without this
      // leaves all of them pointed at the workspace the user just left, and the
      // conversation itself reads as `absent` (see `use-sessions.ts`).
      if (target?.projectId) {
        const { activeProjectId, setActiveProject } = useProjectStore.getState()
        if (target.projectId !== activeProjectId) {
          log.info("switch-to-session crosses workspace", {
            sessionId: id,
            projectId: target.projectId,
          })
          setActiveProject(target.projectId)
        }
      }
      select(id)
      if (!target) return
      setSelectedGuild(guildFromSession(target))
    },
    [select, sessions, setSelectedGuild]
  )

  const isCanvasGuild = selectedGuild.kind === "canvas"

  // Kind lookup for the per-pane dispatchers below: a team session routes to
  // useTeamChat, everything else to useClaudeChat. Both hooks are session-
  // parameterized, so team and direct panes share one ChatPaneGroup.
  const isTeamSessionId = useCallback(
    (sid: string) => {
      // Prefer the resolved active row: a conversation created moments ago is
      // not in the list yet, and misreading it as a direct chat would route its
      // send / close through the wrong hook.
      const s =
        (activeSession?.id === sid ? activeSession : null) ?? sessions.find((x) => x.id === sid)
      return s?.kind === "team" && Boolean(s.teamId)
    },
    [sessions, activeSession]
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

  // Returned (not `void`ed) so the sidebar can drop its optimistic projection
  // of the new order if the write fails.
  const handleReorderSessions = useCallback(
    (ids: string[], sectionKey: string) => setSessionOrder(ids, sectionKey),
    []
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

  // The team-members panel lives in the workbench, outside this tree, so it
  // asks for a mention over the shared seam rather than through a callback
  // (`lib/chat/composer-mention-request.ts`).
  useEffect(() => onComposerMentionRequest((name) => composerRef.current?.insertMention(name)), [])

  const handleCharacterPick = useCallback(
    async (c: Character) => {
      log.info("character-picker pick", { characterId: c.id })
      const s = await create({
        title: tMembers("chatTitle", { name: c.name }),
        kind: "direct",
        characterId: c.id,
      })
      select(s.id)
      setSelectedGuild({ kind: "dm" })
    },
    [create, select, setSelectedGuild, tMembers]
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

  // The conversation sidebar takes the same edge as the nav rail
  // (`settings.sidebarSide`), so the two chat columns stay together. Built
  // once and placed on whichever side, rather than duplicated.
  const channelList = (
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
      onReorderFolders={reorderFolders}
      onAssignToFolder={assignToFolder}
      onReorderSessions={handleReorderSessions}
    />
  )

  return (
    <>
      {isCanvasGuild ? (
        mounted ? (
          <CanvasShell />
        ) : null
      ) : (
        // The one place that turns header projection on: the conversation
        // rail's, the chat pane's and the artifact dock's headers all render
        // into the title bar's zones here (`title-bar-outlets.tsx`), so the
        // workspace sits under a single 40px row instead of one per column.
        <TitleBarProjectionScope enabled>
          {/* Always mounted so the rail can animate its width to 0 when
              collapsed (a smooth transition needs the element to stay in the
              DOM). It self-hides to a 0-width column — no leftover strip — and
              is restored from the title bar's sidebar toggle. State is the single
              `sidebarCollapsed` store field shared with the title/status bars,
              View menu, and ⌘B. */}
          {sidebarSide === "left" ? channelList : null}

          <ArtifactWorkspaceDock>
            <main
              className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
              data-bg-target="chat"
            >
              {!mounted ? null : (
                <>
                  <WorkspaceTrustGate
                    sessionId={activeSession?.id ?? null}
                    promptNonce={trustPromptNonce}
                  />
                  {composerDisabled ? (
                    <div
                      className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-sm"
                      role="status"
                      data-testid="chat-runtime-notice"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">{runtimeT("title")}</p>
                        <p className="text-muted-foreground">
                          {runtimeT(
                            `states.${runtimeAvailabilityMessageKey(chatAvailability.state)}`
                          )}
                        </p>
                      </div>
                      {runtimeRecovery.kind !== "none" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (runtimeRecovery.kind === "route") {
                              router.push(runtimeRecovery.href)
                            } else if (runtimeRecovery.kind === "local-settings") {
                              openSettings(runtimeRecovery.section)
                            }
                          }}
                        >
                          {runtimeT(
                            chatAvailability.state === "requires-pairing"
                              ? "actions.pair"
                              : "actions.connectionSettings"
                          )}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {/* Concurrent chat workspace (direct AND team sessions):
                    optional split, each pane bound to its own session slice +
                    inline approval gate, dispatched by session kind. */}
                  <ChatPaneGroup
                    sessions={sessions}
                    send={paneSend}
                    stop={paneStop}
                    steerNow={paneSteer}
                    steerFlush={paneFlush}
                    regenerate={paneRegenerate}
                    editResend={paneEditResend}
                    rewindFiles={directChat.rewindFiles}
                    compact={directChat.compact}
                    setModel={directChat.setModel}
                    resetRuntime={directChat.resetRuntime}
                    respondToApproval={handleApprovalRespond}
                    onCreate={handleCreate}
                    onUseSample={handleUseSample}
                    onOpenSettings={openSettings}
                    recentSessions={recentSessions}
                    onResumeSession={handleSwitchToSession}
                    composerRef={composerRef}
                    composerDisabled={composerDisabled}
                    onResumeAfterPlanApproval={resumeAfterPlanApproval}
                  />
                </>
              )}
            </main>
          </ArtifactWorkspaceDock>

          {sidebarSide === "right" ? channelList : null}
        </TitleBarProjectionScope>
      )}

      <CharacterPicker
        open={characterPickerOpen}
        onOpenChange={setCharacterPickerOpen}
        onPick={handleCharacterPick}
      />
    </>
  )
}

function runtimeAvailabilityMessageKey(state: OperationAvailabilityState): string {
  return state.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
