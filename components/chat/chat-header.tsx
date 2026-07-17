"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChartLineIcon,
  KeyRoundIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Settings2Icon,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { PlanModeTasksSheet } from "@/components/agent/workspace/plan-mode-tasks-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { AgentFlowDisplayToggle } from "@/components/chat/agent-flow-display-toggle"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { SessionInsightsSheet } from "@/components/chat/session-insights/session-insights-sheet"
import { useUIStore } from "@/stores/ui"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession
  onOpenSettings?: () => void
}

/**
 * Slim chat header: identity (avatar / title / character) + ambient status
 * (live cost, plan-mode tasks, no-API-key warning) + the `chat.header` plugin
 * slot + a single `⚙` trigger that opens the consolidated
 * `SessionSettingsSheet`. All low-frequency configuration and lifecycle
 * actions live in that sheet (control-surface consolidation — area ①); model /
 * permission / mode are edited inline on the composer toolbar.
 */
export function ChatHeader({ session, onOpenSettings }: Props) {
  const t = useTranslations("chat.header")
  const character = useCharacter(session.characterId)
  // Reactive credential status (api key OR subscription bearer). Re-reads on
  // profile unlock and subscription-changed broadcasts, so the badge never
  // latches a stale "No API key" for a subscription-reuse user whose bearer
  // lands after boot.
  const { keyOk } = useCredentialStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)

  // Conversation-sidebar (ChannelList) toggle. Lives here — in the active
  // conversation's top bar — so collapsing the list fully reclaims its column
  // yet stays one click away from being restored, without a leftover rail.
  // Same single `sidebarCollapsed` store field the title bar, status bar, View
  // menu, and ⌘B drive, so every surface stays in lockstep. Desktop-only: the
  // list is a Sheet (hamburger) below `md`, where collapse does not apply.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const sidebarToggleLabel = sidebarCollapsed ? t("showConversations") : t("hideConversations")

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        className="hidden size-8 shrink-0 md:inline-flex"
        onClick={toggleSidebar}
        aria-label={sidebarToggleLabel}
        aria-pressed={!sidebarCollapsed}
        title={sidebarToggleLabel}
        data-testid="chat-sidebar-toggle"
      >
        {sidebarCollapsed ? (
          <PanelLeftOpenIcon className="size-4" />
        ) : (
          <PanelLeftCloseIcon className="size-4" />
        )}
      </Button>
      <div className="flex flex-1 items-center gap-2 truncate">
        {character && (
          <Avatar className="size-7 shrink-0" title={character.name}>
            <AvatarFallback
              className="text-xs text-white"
              style={{ backgroundColor: avatarColor(character) }}
              aria-hidden
            >
              {avatarGlyph(character)}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium" title={session.title}>
            {session.title || t("untitledSession")}
          </span>
          {character && (
            <span
              className="truncate text-[11px] text-muted-foreground"
              title={character.description}
            >
              {character.name}
              {character.description ? ` · ${character.description}` : ""}
            </span>
          )}
        </div>
        {keyOk === false && (
          <Badge variant="destructive" className="cursor-pointer gap-1" onClick={onOpenSettings}>
            <KeyRoundIcon className="size-3" />
            {t("noApiKey")}
          </Badge>
        )}
      </div>

      <SessionCostBadgeLive
        sessionId={session.id}
        tokensLabel={(input, output) => t("tokensLabel", { input, output })}
      />

      {/* Plan-mode tasks for a non-team chat. Self-hides (returns null) when the
          synthetic `solo:<sessionId>` team has no tasks, so it only appears once
          the plan-mode bridge has emitted a plan for this session. */}
      <PlanModeTasksSheet sessionId={session.id} />

      <PluginExtensionSlot point="chat.header" className="flex items-center gap-1 empty:hidden" />

      {/* Quick simplified/standard/detailed switch — same global preference the
          appearance settings card and session sheet drive. Desktop-only to keep
          the mobile header slim; the sheet toggle remains the mobile entry. */}
      <AgentFlowDisplayToggle className="hidden md:flex" />

      <Button
        variant="ghost"
        size="icon"
        aria-label={t("insights")}
        onClick={() => setInsightsOpen(true)}
      >
        <ChartLineIcon className="size-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        aria-label={t("ariaSettings")}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings2Icon className="size-4" />
      </Button>

      <SessionSettingsSheet session={session} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <SessionInsightsSheet session={session} open={insightsOpen} onOpenChange={setInsightsOpen} />
    </header>
  )
}
