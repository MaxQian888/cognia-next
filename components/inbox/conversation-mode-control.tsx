"use client"

/**
 * "What will the next turn run as" — the behaviour-preset control for one IM
 * conversation, in the one place that knows how to derive it.
 *
 * Extracted from `conversation-header.tsx` so the chat header and the Inbox
 * triage pane cannot drift on either half of it:
 *
 *  - The preset is read through `useImEffectiveConfig`, the same resolver the
 *    bus and the override dialog run, over the LIVE override row, so an SLA
 *    escalation or another shell rewriting the mode shows up here at once.
 *  - The write is routed (ADR-0131), not desktop-only: a paired phone mirrors
 *    locally and relays to its host. Only an `"unavailable"` route — a
 *    standalone tab, an unpaired phone — gets the static disabled badge.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useImEffectiveConfig } from "@/hooks/connectors/use-im-effective-config"
import {
  imModePresetFor,
  IM_MODE_CUSTOM,
  type ImModePresetId,
} from "@/lib/connectors/composition/im-mode-presets"
import { useInboxWriteRoute } from "@/lib/connectors/inbox-writes"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { ModeSwitcher } from "./mode-switcher"

export interface ConversationModeControlProps {
  conversationKey: string
  sessionId: string
  /** Parsed from the conversationKey; "" when unparseable. */
  adapterId: string
  /** The live override row (`undefined` while loading or when absent). */
  overrideRow: ConversationOverrideRow | undefined
  /** Opens the per-conversation settings dialog (the `custom` destination). */
  onOpenAdvanced?: () => void
  /** Fires after a successful behaviour write, with the preset that landed. */
  onModeChange?: (preset: ImModePresetId) => void
}

export function ConversationModeControl({
  conversationKey,
  sessionId,
  adapterId,
  overrideRow,
  onOpenAdvanced,
  onModeChange,
}: ConversationModeControlProps) {
  const t = useTranslations("inbox.conversationHeader")
  const tPresets = useTranslations("inbox.modeSwitcher.presets")
  const effectiveConfig = useImEffectiveConfig({ adapterId, override: overrideRow ?? null })
  const selection = effectiveConfig
    ? imModePresetFor({
        autonomy: effectiveConfig.autonomy.effective,
        engagement: effectiveConfig.engagement.effective,
      })
    : IM_MODE_CUSTOM
  const targetKind = effectiveConfig?.target.effective.kind ?? "direct"
  const writeRoute = useInboxWriteRoute()

  if (writeRoute === "unavailable") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="opacity-60"
            data-testid="mode-switcher-disabled"
            aria-disabled="true"
          >
            {tPresets(selection)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{t("modeSwitchRequiresHost")}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <ModeSwitcher
      conversationKey={conversationKey}
      sessionId={sessionId}
      selection={selection}
      targetKind={targetKind}
      onOpenAdvanced={onOpenAdvanced}
      onSelectionChange={onModeChange}
    />
  )
}
