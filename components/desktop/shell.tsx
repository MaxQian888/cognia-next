"use client"

import { useEffect, useRef, useState } from "react"
import { ChatPane } from "@/components/chat/chat-view"
import { CharacterPicker } from "@/components/chat/character-picker"
import { CommandPalette } from "@/components/desktop/command-palette"
import { GuildRail } from "@/components/desktop/guild-rail"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/desktop/member-list"
import { ArtifactPanel } from "@/components/artifacts/artifact-panel"
import { CanvasDocumentRail, CanvasWorkspace, CanvasSidePanels } from "@/components/canvas"
import { OnboardingDialog } from "@/components/desktop/onboarding-dialog"
import { TitleBar } from "@/components/desktop/title-bar"
import { SettingsDialog } from "@/components/chat/settings-dialog"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import type { ComposerHandle } from "@/components/chat/composer"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { isTauri } from "@/lib/tauri"
import { whenSeeded } from "@/lib/db/schema"
import { markSessionRead } from "@/lib/db/session-state"
import { guildFromSession } from "@/lib/claude/guild"
import { loggers } from "@/lib/logger"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

const log = loggers.shell

/**
 * The top-level Discord-style frame:
 *
 *   ┌───────────── TitleBar ─────────────┐
 *   │ Guild │ Channel │ ChatPane │ Mems  │
 *   │ rail  │ list    │          │       │
 *   └────────────────────────────────────┘
 *
 * Owns the cross-cutting pieces (dialogs, command palette, hook wiring) so
 * that the inner panes stay narrow and focused.
 */
export function DiscordShell() {
  const { sessions, activeSessionId, select, create, remove, rename } = useSessions()
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()

  const errorMessage = useChatStore((s) => s.errorMessage)
  const pendingApproval = useChatStore((s) => s.pendingApprovals[0] ?? null)

  const loadSettings = useSettingsStore((s) => s.load)
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const pendingSettingsRequest = useUIStore((s) => s.pendingSettingsRequest)
  const clearPendingSettings = useUIStore((s) => s.clearPendingSettings)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string>("general")
  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)

  // Imperative handle on the chat composer — the member-list rail uses this
  // to insert `@CharacterName` mentions at the caret without going through
  // any draft store.
  const composerRef = useRef<ComposerHandle | null>(null)

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    void whenSeeded()
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // Whenever the active session changes, mark it as read.
  useEffect(() => {
    if (!activeSessionId) return
    void markSessionRead(activeSessionId).catch((err) => {
      log.warn("markSessionRead failed", {
        sessionId: activeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, [activeSessionId])

  // First-run onboarding: nudge the user when there's no API key and they
  // haven't already dismissed the wizard this session.
  useEffect(() => {
    if (!mounted) return
    const settings = useSettingsStore.getState().settings
    if (!settings) return
    if (!settings.apiKey && !onboardingDismissed && sessions.length === 0) {
      log.info("onboarding shown")
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOnboardingOpen(true)
    }
  }, [mounted, onboardingDismissed, sessions.length])

  // Auto-select the most-recent session on first render — but only one that
  // matches the current guild. (If the user switched guilds and there's no
  // matching session yet, we leave the pane in its empty state.)
  useEffect(() => {
    if (!mounted) return
    if (activeSessionId) {
      const current = sessions.find((s) => s.id === activeSessionId)
      // If the active session belongs to a different guild, surface that mismatch
      // by switching the guild rather than dropping the active session.
      if (current && selectedGuild.kind === "team") {
        if (current.kind !== "team" || current.teamId !== selectedGuild.teamId) {
          // Honor the active session and adjust the guild filter.
          const target = guildFromSession(current)
          log.info("auto guild-switch from active session", {
            sessionId: current.id,
            target,
          })
          setSelectedGuild(target)
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
      log.info("auto-select session", { sessionId: matching.id })
      select(matching.id)
    }
  }, [mounted, sessions, activeSessionId, selectedGuild, select, setSelectedGuild])

  // Surface non-fatal errors as toasts (debounced).
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

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  const openSettings = (tab?: string) => {
    log.info("open settings", { tab: tab ?? "general" })
    setSettingsTab(tab ?? "general")
    setSettingsOpen(true)
  }

  // Honor open-settings requests coming from the tray, app menu, or
  // deep-link handler. The store carries a nonce so repeated requests
  // re-trigger this effect even when the tab string didn't change.
  useEffect(() => {
    if (!pendingSettingsRequest) return
    log.info("open settings via deep-link", { tab: pendingSettingsRequest.tab })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openSettings(pendingSettingsRequest.tab)
    clearPendingSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSettingsRequest])

  const handleNewDirect = () => {
    log.info("new-direct (open character picker)")
    // Open the character picker; the actual session is created in onPick.
    setCharacterPickerOpen(true)
  }

  const handleNewTeamConversation = async (teamId: string) => {
    log.info("new-team-conversation", { teamId })
    const s = await create({ title: "New conversation", kind: "team", teamId })
    select(s.id)
  }

  // Team creation is fully implemented in Settings → Teams. The guild rail's
  // "+" button silently routes there; no toast needed.
  const handleCreateTeam = () => {
    log.info("create-team click → settings")
    openSettings("teams")
  }

  const handleSwitchToSession = (id: string) => {
    log.info("switch-to-session", { sessionId: id })
    select(id)
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    setSelectedGuild(guildFromSession(target))
  }

  // Member-list is only shown for team sessions, and only on wide enough screens.
  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)
  const isCanvasGuild = selectedGuild.kind === "canvas"

  // Pick the right send/stop pair based on session kind. Team sessions go
  // through `useTeamChat`, direct chats stay on `useClaudeChat`.
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

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <GuildRail onCreateTeam={handleCreateTeam} onOpenSettings={() => openSettings()} />
        {isCanvasGuild ? (
          <CanvasDocumentRail />
        ) : (
          <ChannelList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={handleSwitchToSession}
            onNewDirect={() => void handleNewDirect()}
            onNewTeamConversation={(id) => void handleNewTeamConversation(id)}
            onDelete={(id) => void remove(id)}
            onRename={(id, title) => void rename(id, title)}
          />
        )}

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {!mounted ? null : isCanvasGuild ? (
            <CanvasWorkspace />
          ) : !isTauri() ? (
            <DesktopOnlyBanner />
          ) : (
            <ChatPane
              activeSession={activeSession}
              onSend={send}
              onStop={stop}
              onRegenerate={isTeamSession ? teamChat.regenerate : directChat.regenerate}
              onEditResend={isTeamSession ? teamChat.editAndResend : directChat.editAndResend}
              onCreate={handleNewDirect}
              onUseSample={(text) => void send(text)}
              onOpenSettings={openSettings}
              composerRef={composerRef}
            />
          )}
        </main>

        {isCanvasGuild ? (
          <aside className="hidden w-[300px] shrink-0 border-l md:block">
            <CanvasSidePanels />
          </aside>
        ) : (
          isTeamSession && (
            <MemberList
              teamSessionId={activeSession?.id ?? null}
              teamId={activeSession?.teamId ?? null}
              onMention={(c) => {
                composerRef.current?.insertMention(c.name)
              }}
            />
          )
        )}
        {!isCanvasGuild && <ArtifactPanel />}
      </div>

      <CharacterPicker
        open={characterPickerOpen}
        onOpenChange={setCharacterPickerOpen}
        onPick={async (c) => {
          log.info("character-picker pick", { characterId: c.id })
          const s = await create({
            title: `Chat with ${c.name}`,
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
          if (!open) {
            log.info("onboarding dismissed")
            setOnboardingDismissed(true)
          }
        }}
        onPickCharacter={async (c) => {
          log.info("onboarding pick-character", { characterId: c.id })
          const s = await create({
            title: `Chat with ${c.name}`,
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
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} defaultTab={settingsTab} />
      {mounted && <CommandPalette onOpenSettings={openSettings} />}
    </div>
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
