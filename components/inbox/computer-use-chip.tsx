"use client"

/**
 * Read-only mini chip surfacing the per-conversation `allowComputerUse`
 * flag in the Inbox.
 *
 * Distinct from `components/inbox/overrides/computer-use-toggle.tsx`,
 * which is the interactive header control that requires a biometric
 * confirmation to flip. The chip is for places where we just want to
 * make the elevated-permission state visible without offering a flip
 * affordance — currently the conversation list row tail and the
 * conversation header (read-only mirror of the toggle).
 *
 * Renders nothing when the flag is false / undefined so unchanged
 * conversations don't get visual noise.
 */

import { useTranslations } from "next-intl"
import { ComputerIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface ComputerUseChipProps {
  active: boolean
  /** Apply additional layout classes (e.g. `ml-1`) at the call site. */
  className?: string
}

export function ComputerUseChip({ active, className }: ComputerUseChipProps) {
  const t = useTranslations("inbox.conversationHeader.computerUseChip")
  if (!active) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={t("aria")}
          data-testid="computer-use-chip"
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded-full border border-destructive/40",
            "bg-destructive/10 px-1.5 text-[10px] font-medium uppercase text-destructive",
            className
          )}
        >
          <ComputerIcon className="h-3 w-3" aria-hidden />
          {t("label")}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] text-xs">{t("tooltip")}</TooltipContent>
    </Tooltip>
  )
}
