"use client"

// Drop-in trigger button for the chat header. Opens the SingleExportDialog
// for the active session. Renders nothing when there's no active session.

import { useTranslations } from "next-intl"
import { Share2Icon } from "lucide-react"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { SingleExportDialog } from "@/components/data/export/single-export-dialog"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession | null | undefined
  /** Compact icon button vs labeled button. Default icon-only. */
  variant?: "icon" | "labeled" | "share"
  /** Extra classes for the trigger button (e.g. to stretch it in a grid). */
  className?: string
}

export function SingleExportTrigger({ session, variant = "icon", className }: Props) {
  const t = useTranslations("export")
  const tRow = useTranslations("desktop.sessionRow")
  if (!session) return null

  const trigger =
    variant !== "labeled" ? (
      <TooltipIconButton
        variant="ghost"
        size="icon"
        aria-label={variant === "share" ? tRow("exportShare") : t("singleTitle")}
        tooltip={variant === "share" ? tRow("exportShare") : t("singleTitle")}
        className={className}
      >
        {variant === "share" ? (
          <Share2Icon className="size-4" />
        ) : (
          <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
        )}
      </TooltipIconButton>
    ) : (
      <Button variant="outline" size="sm" className={className}>
        <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} data-icon="inline-start" />
        {t("singleTitle")}
      </Button>
    )

  return <SingleExportDialog session={session} trigger={trigger} />
}
