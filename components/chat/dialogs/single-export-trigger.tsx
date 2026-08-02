"use client"

// Drop-in trigger button for the chat header. Opens the SingleExportDialog
// for the active session. Renders nothing when there's no active session.

import { useTranslations } from "next-intl"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { SingleExportDialog } from "@/components/data/export/single-export-dialog"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession | null | undefined
  /** Compact icon button vs labeled button. Default icon-only. */
  variant?: "icon" | "labeled"
}

export function SingleExportTrigger({ session, variant = "icon" }: Props) {
  const t = useTranslations("export")
  if (!session) return null

  const trigger =
    variant === "icon" ? (
      <TooltipIconButton
        variant="ghost"
        size="icon"
        aria-label={t("singleTitle")}
        tooltip={t("singleTitle")}
      >
        <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
      </TooltipIconButton>
    ) : (
      <Button variant="outline" size="sm">
        <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} data-icon="inline-start" />
        {t("singleTitle")}
      </Button>
    )

  return <SingleExportDialog session={session} trigger={trigger} />
}
