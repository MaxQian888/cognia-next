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

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ChatPane } from "@/components/chat/chat-view"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ChannelList } from "@/components/desktop/channel-list"
import { MemberList } from "@/components/desktop/member-list"
import { ArtifactPanel } from "@/components/artifacts/artifact-panel"
import { CanvasShell } from "@/components/canvas"
import { OnboardingDialog } from "@/components/desktop/onboarding-dialog"
import { ToolApprovalDialog } from "@/components/chat/tool-approval-dialog"
import type { ComposerHandle } from "@/components/chat/composer"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { usePlatform } from "@/hooks/use-platform"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { markSessionRead } from "@/lib/db/session-state"
import { guildFromSession } from "@/lib/claude/guild"
import { loggers } from "@/lib/logger"

const log = loggers.shell

export function DesktopChatWorkspace() {
  const platform = usePlatform()
  const router = useRouter()
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
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  const [lastErrorShown, setLastErrorShown] = useState<string | null>(null)
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)

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
    if (!settings.apiKey && !onboardingDismissed && sessions.length === 0) {
      log.info("onboarding shown")
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOnboardingOpen(true)
    }
  }, [mounted, onboardingDismissed, sessions.length])

  useEffect(() => {
    if (!mounted) return
    if (activeSessionId) {
      const current = sessions.find((s) => s.id === activeSessionId)
      if (current && selectedGuild.kind === "team") {
        if (current.kind !== "team" || current.teamId !== selectedGuild.teamId) {
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
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

  useEffect(() => {
    if (!pendingSettingsRequest) return
    log.info("open settings via deep-link", { tab: pendingSettingsRequest.tab })

    openSettings(pendingSettingsRequest.tab)
    clearPendingSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSettingsRequest])

  const handleNewDirect = () => {
    log.info("new-direct (open character picker)")
    setCharacterPickerOpen(true)
  }

  const handleNewTeamConversation = async (teamId: string) => {
    log.info("new-team-conversation", { teamId })
    const s = await create({ title: "New conversation", kind: "team", teamId })
    select(s.id)
  }

  const handleSwitchToSession = (id: string) => {
    log.info("switch-to-session", { sessionId: id })
    select(id)
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    setSelectedGuild(guildFromSession(target))
  }

  const isTeamSession = activeSession?.kind === "team" && Boolean(activeSession.teamId)
  const isCanvasGuild = selectedGuild.kind === "canvas"

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
              activeSessionId={activeSessionId}
              onSelect={handleSwitchToSession}
              onNewDirect={() => void handleNewDirect()}
              onNewTeamConversation={(id) => void handleNewTeamConversation(id)}
              onDelete={(id) => void remove(id)}
              onRename={(id, title) => void rename(id, title)}
            />
          )}

          <main
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
            data-bg-target="chat"
          >
            {!mounted ? null : platform !== "tauri" ? (
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

          {isTeamSession && (
            <MemberList
              teamSessionId={activeSession?.id ?? null}
              teamId={activeSession?.teamId ?? null}
              onMention={(c) => {
                composerRef.current?.insertMention(c.name)
              }}
            />
          )}
          <ArtifactPanel />
        </>
      )}

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
