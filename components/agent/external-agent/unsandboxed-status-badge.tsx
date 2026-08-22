"use client"

/**
 * The persistent "this Agent is running outside the sandbox" indicator.
 *
 * Consent is collected once; this is what keeps it visible afterwards. Without
 * a standing indicator, a decision made weeks ago silently governs every
 * subsequent run, and the one Agent on the machine with no sandbox looks
 * exactly like the ones that have one.
 *
 * Renders nothing when the Agent is sandboxed, so call sites can mount it
 * unconditionally rather than each re-deriving the condition — the kind of
 * duplicated predicate that drifts.
 *
 * @see ./unsandboxed-consent-dialog.tsx
 */

import { useTranslations } from "next-intl"
import { ShieldOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface UnsandboxedStatusBadgeProps {
  /** Whether this Agent currently launches outside the sandbox. */
  unsandboxed: boolean
  /** Resolved executable the consent was granted for, shown on hover. */
  executablePath?: string
  className?: string
}

export function UnsandboxedStatusBadge({
  unsandboxed,
  executablePath,
  className,
}: UnsandboxedStatusBadgeProps) {
  const t = useTranslations("externalAgent.unsandboxed")

  if (!unsandboxed) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="destructive"
          className={cn("gap-1", className)}
          data-testid="unsandboxed-status-badge"
        >
          <ShieldOff className="size-3" aria-hidden="true" />
          {t("badge")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>{t("badgeTooltip")}</p>
        {executablePath ? (
          <p className="mt-1 font-mono text-xs break-all">{executablePath}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
