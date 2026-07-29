"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon, Settings2Icon } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { Badge } from "@/components/ui/badge"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { PlanModeTasksSheet } from "@/components/agent/workspace/plan-mode-tasks-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { BranchLineageChip } from "@/components/chat/branch-lineage-chip"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession
  onOpenSettings?: () => void
}

/**
 * Chat header — one 36px line: who you are talking to, what it is costing, and
 * two controls.
 *
 * It carried six icon buttons and a two-line title. Everything that was not
 * touched per turn moved to where it belongs: the sidebar toggle to Views (it
 * had four entry points driving one field), the browser-dock opener into the
 * artifact dock's own menu, the agent-flow density switch to the settings sheet
 * that already had a copy of it, and Insights to a row in the same sheet.
 *
 * What stays is either ambient status that self-hides (live cost, plan-mode
 * tasks, the no-credential badge, the `chat.header` plugin slot) or the single
 * owner of a frequent action: `⚙` for this session's settings, and the toggle
 * for the pane on the right.
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

  const characterTooltip = character
    ? character.description
      ? `${character.name} · ${character.description}`
      : character.name
    : undefined

  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <div className="flex flex-1 items-center gap-2 truncate">
        {character && (
          <Avatar className="size-6 shrink-0" title={characterTooltip}>
            <AvatarFallback
              className="text-[10px] text-white"
              style={{ backgroundColor: avatarColor(character) }}
              aria-hidden
            >
              {avatarGlyph(character)}
            </AvatarFallback>
          </Avatar>
        )}
        {/* One line, not two. The character name and description were a second
            row of permanent text that repeated what the avatar already signals
            and pushed the header to 48px; they are the title's tooltip now. */}
        <span
          className="truncate text-sm font-medium"
          title={characterTooltip ? `${session.title} — ${characterTooltip}` : session.title}
        >
          {session.title || t("untitledSession")}
        </span>
        {/* Self-hides unless this session was branched from another one. */}
        <BranchLineageChip session={session} />
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

      {/* Two buttons, down from six. The browser-dock opener moved into the
          artifact dock's own menu, the agent-flow density switch already had a
          copy in the settings sheet and the appearance settings, and Insights
          became a row inside the sheet — none of the three is touched per turn.
          What is left is the one place to configure this session and the one
          toggle for the pane beside it. */}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("ariaSettings")}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings2Icon className="size-4" />
      </Button>

      {/* Pointer-width only: below `md` the dock is a Sheet whose opener lives
          in the mobile shell's own top bar, and this header is suppressed
          there anyway (`showHeader={false}`). */}
      <ArtifactDockToggle className="hidden md:inline-flex" />

      <SessionSettingsSheet session={session} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  )
}
