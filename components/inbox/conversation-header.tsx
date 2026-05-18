"use client"

/**
 * Conversation header strip for the Inbox detail pane.
 *
 * Left: platform avatar (PlatformBadge) + character chip + conversation name.
 * Middle: mode chip (ModeSwitcher live in Tauri; static disabled badge on web).
 * Right: policy info chip (PolicyInfo).
 */

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon } from "lucide-react"
import { ModeSwitcher } from "./mode-switcher"
import { ProviderModelSwitcher } from "./provider-model-switcher"
import { PolicyInfo } from "./policy-info"
import { PlatformBadge } from "./platform-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
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
  /** Current ConversationOverrideRow.providerOverride, if set. */
  providerOverride?: string
  /** Current ConversationOverrideRow.modelOverride, if set. */
  modelOverride?: string
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
  providerOverride,
  modelOverride,
  onModeChange,
}: ConversationHeaderProps) {
  const t = useTranslations("inbox.conversationHeader")
  const tModes = useTranslations("inbox.modeSwitcher.modes")
  const desktop = isTauri()
  const character = useCharacter(characterId)
  const router = useRouter()

  // Mobile back: prefer router.back() so we restore the previous Inbox list /
  // scope; fall back to /inbox when this is a fresh deep-link load with no
  // history to pop.
  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
    } else {
      router.push("/inbox")
    }
  }

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:gap-3 md:px-4"
      data-testid="conversation-header"
    >
      {/* Mobile-only nav cluster: back to the conversation list + open the
       * adapters Sheet. Hidden on md+ where the three-pane shell exposes
       * both surfaces directly. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={handleBack}
        aria-label={t("backToList")}
        data-testid="conversation-header-back"
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </Button>
      <SidebarTrigger
        className="md:hidden"
        aria-label={t("openSidebar")}
        data-testid="conversation-header-open-sidebar"
      />

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
        <>
          <ModeSwitcher
            conversationKey={conversationKey}
            sessionId={sessionId}
            currentMode={currentMode}
            onModeChange={onModeChange}
          />
          {/* A6 — per-channel provider/model override (ADR-0009 v41). */}
          <ProviderModelSwitcher
            conversationKey={conversationKey}
            sessionId={sessionId}
            providerOverride={providerOverride}
            modelOverride={modelOverride}
          />
        </>
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
