"use client"

/**
 * Conversation header strip for the Inbox detail pane.
 *
 * Left: platform avatar (PlatformBadge) + character chip + conversation name.
 * Middle: mode chip (ModeSwitcher live in Tauri; static disabled badge on web).
 * Right: policy info chip (PolicyInfo).
 */

import { useTranslations } from "next-intl"
import { ModeSwitcher } from "./mode-switcher"
import { PolicyInfo } from "./policy-info"
import { PlatformBadge } from "./platform-badge"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isTauri } from "@/lib/tauri"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { ConnectorMode, TriggerPolicy } from "@/types/connectors/policy"
import type { PlatformKind } from "@/types/connectors/platform-kind"

interface ConversationHeaderProps {
  conversationKey: string
  sessionId: string
  title: string
  platform: PlatformKind
  currentMode: ConnectorMode
  policy: TriggerPolicy
  characterId?: string
  onModeChange?: (mode: ConnectorMode) => void
}

export function ConversationHeader({
  conversationKey,
  sessionId,
  title,
  platform,
  currentMode,
  policy,
  characterId,
  onModeChange,
}: ConversationHeaderProps) {
  const t = useTranslations("inbox.conversationHeader")
  const tModes = useTranslations("inbox.modeSwitcher.modes")
  const desktop = isTauri()
  const character = useCharacter(characterId)

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
      data-testid="conversation-header"
    >
      {/* Left: platform + character chip + title */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <PlatformBadge platform={platform} iconOnly />
        {character && (
          <span
            className="flex items-center gap-1.5 min-w-0"
            data-testid="conversation-character-chip"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
              style={{ backgroundColor: avatarColor(character), color: "white" }}
              aria-hidden
              title={character.name}
            >
              {avatarGlyph(character)}
            </span>
            <span className="truncate text-xs text-muted-foreground" title={character.name}>
              {character.name}
            </span>
          </span>
        )}
        <h2 className="text-sm font-semibold truncate">{title}</h2>
      </div>

      {/* Middle: live ModeSwitcher on desktop, static disabled badge on web */}
      {desktop ? (
        <ModeSwitcher
          conversationKey={conversationKey}
          sessionId={sessionId}
          currentMode={currentMode}
          onModeChange={onModeChange}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="opacity-60"
              data-testid="mode-switcher-disabled"
              aria-disabled="true"
            >
              {tModes(currentMode)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{t("modeSwitchDesktopOnly")}</TooltipContent>
        </Tooltip>
      )}

      {/* Right: policy info */}
      <PolicyInfo policy={policy} />
    </header>
  )
}
