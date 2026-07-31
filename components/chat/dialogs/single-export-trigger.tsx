"use client"

// Drop-in trigger button for the chat header. Opens the SingleExportDialog
// for the active session. Renders nothing when there's no active session.

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { DownloadIcon } from "lucide-react"
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
        <DownloadIcon className="size-4" />
      </TooltipIconButton>
    ) : (
      <Button variant="outline" size="sm">
        <DownloadIcon className="mr-1.5 size-4" />
        {t("singleTitle")}
      </Button>
    )

  return <SingleExportDialog session={session} trigger={trigger} />
}
