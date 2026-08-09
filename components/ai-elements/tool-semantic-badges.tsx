"use client"

import { useTranslations } from "next-intl"
import { EyeIcon, PencilIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export interface ToolSemanticBadgesProps {
  readOnlyHint?: boolean | null
}

/** Capability badges supplied by the tool protocol; not execution outcomes. */
export function ToolSemanticBadges({ readOnlyHint }: ToolSemanticBadgesProps) {
  const t = useTranslations("chat.agentFlow.semantic")
  if (readOnlyHint === undefined || readOnlyHint === null) return null

  return readOnlyHint ? (
    <Badge variant="outline" className="gap-1 rounded-full text-[10px]" data-testid="tool-readonly">
      <EyeIcon className="size-3" aria-hidden />
      {t("readOnly")}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 rounded-full border-blue-500/40 bg-blue-500/10 text-[10px] text-blue-700 dark:text-blue-400"
      data-testid="tool-write-capable"
    >
      <PencilIcon className="size-3" aria-hidden />
      {t("writeCapable")}
    </Badge>
  )
}
