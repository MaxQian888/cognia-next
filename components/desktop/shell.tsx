"use client"

import { useEffect, useState } from "react"
import { ChatPane } from "@/components/chat/chat-view"
import { CharacterPicker } from "@/components/chat/character-picker"
import { CommandPalette } from "@/components/desktop/command-palette"
import { GuildRail } from "@/components/desktop/guild-rail"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/desktop/member-list"
import { OnboardingDialog } from "@/components/desktop/onboarding-dialog"
import { TitleBar } from "@/components/desktop/title-bar"
import { SettingsDialog } from "@/components/chat/settings-dialog"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import { useClaudeChat } from "@/hooks/use-claude-chat"
import { useTeamChat } from "@/hooks/use-team-chat"
import { useSessions } from "@/hooks/use-sessions"
import { useChatStore } from "@/stores/chat-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useUIStore } from "@/stores/ui-store"
import { isTauri } from "@/lib/tauri"
import { whenSeeded } from "@/lib/db/schema"
import { markSessionRead } from "@/lib/db/session-state"
import { toast } from "sonner"

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
    void markSessionRead(activeSessionId).catch(() => {})
  }, [activeSessionId])

  // First-run onboarding: nudge the user when there's no API key and they
  // haven't already dismissed the wizard this session.
  useEffect(() => {
    if (!mounted) return
    const settings = useSettingsStore.getState().settings
    if (!settings) return
    if (!settings.apiKey && !onboardingDismissed && sessions.length === 0) {
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
          if (current.kind === "team" && current.teamId) {
            setSelectedGuild({ kind: "team", teamId: current.teamId })
          } else {
            setSelectedGuild({ kind: "dm" })
          }
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
    if (matching) select(matching.id)
  }, [mounted, sessions, activeSessionId, selectedGuild, select, setSelectedGuild])

  // Surface non-fatal errors as toasts (debounced).
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

  const openSettings = (tab?: string) => {
    setSettingsTab(tab ?? "general")
    setSettingsOpen(true)
  }

  // Honor open-settings requests coming from the tray, app menu, or
  // deep-link handler. The store carries a nonce so repeated requests
  // re-trigger this effect even when the tab string didn't change.
  useEffect(() => {
    if (!pendingSettingsRequest) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openSettings(pendingSettingsRequest.tab)
    clearPendingSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSettingsRequest])

  const handleNewDirect = () => {
    // Open the character picker; the actual session is created in onPick.
    setCharacterPickerOpen(true)
  }

  const handleNewTeamConversation = async (teamId: string) => {
    const s = await create({ title: "New conversation", kind: "team", teamId })
    select(s.id)
  }

  const handleCreateTeam = () => {
    // The Teams settings tab lands in Phase 4. Until then, deep-link to the
    // closest tab and surface a hint.
    toast.info("Team creation lands with the Teams tab — check Settings → Teams.")
    openSettings("teams")
  }

  const handleSwitchToSession = (id: string) => {
    select(id)
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    if (target.kind === "team" && target.teamId) {
      setSelectedGuild({ kind: "team", teamId: target.teamId })
    } else {
      setSelectedGuild({ kind: "dm" })
    }
  }

  // Member-list is only shown for team sessions, and only on wide enough screens.
  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)

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
        <ChannelList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={handleSwitchToSession}
          onNewDirect={() => void handleNewDirect()}
          onNewTeamConversation={(id) => void handleNewTeamConversation(id)}
          onDelete={(id) => void remove(id)}
          onRename={(id, t) => void rename(id, t)}
        />

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {!mounted ? null : !isTauri() ? (
            <DesktopOnlyBanner />
          ) : (
            <ChatPane
              activeSession={activeSession}
              onSend={send}
              onStop={stop}
              onRegenerate={isTeamSession ? teamChat.regenerate : directChat.regenerate}
              onEditResend={isTeamSession ? async () => {} : directChat.editAndResend}
              onCreate={handleNewDirect}
              onUseSample={(text) => void send(text)}
              onOpenSettings={openSettings}
            />
          )}
        </main>

        {isTeamSession && (
          <MemberList
            teamSessionId={activeSession?.id ?? null}
            teamId={activeSession?.teamId ?? null}
            onMention={(c) => {
              // Phase 4 will hook this into the composer; for now just bump
              // the draft directly.
              const sid = activeSession?.id
              if (!sid) return
              const current = useUIStore.getState().composerDraft[sid] ?? ""
              const sep = current && !current.endsWith(" ") ? " " : ""
              useUIStore.getState().setComposerDraft(sid, `${current}${sep}@${c.name} `)
            }}
          />
        )}
      </div>

      <CharacterPicker
        open={characterPickerOpen}
        onOpenChange={setCharacterPickerOpen}
        onPick={async (c) => {
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
          if (!open) setOnboardingDismissed(true)
        }}
        onPickCharacter={async (c) => {
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
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h2 className="text-xl font-semibold">Run inside Tauri</h2>
        <p className="text-sm text-muted-foreground">
          The Claude Code agent runs in a Node sidecar that ships with the desktop build. To use the
          chat, launch the app with{" "}
          <code className="rounded bg-muted px-1 py-0.5">pnpm tauri dev</code> rather than{" "}
          <code className="rounded bg-muted px-1 py-0.5">pnpm dev</code>.
        </p>
      </div>
    </div>
  )
}
