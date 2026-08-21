"use client"

/**
 * A gate that was answered, recorded where the decision applies.
 *
 * Compact by design — one line. This is a receipt, not an event the reader
 * needs to act on: by the time it renders, the decision is already made and
 * the run has moved on. Its job is to make "what did I approve, and when"
 * answerable later, which a dismissed modal cannot do.
 */

import { memo } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { CheckIcon, ShieldQuestionIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { SquadGatePart as SquadGatePartType } from "@/lib/claude/parts-extensions"

interface Props {
  part: SquadGatePartType
}

const DECISION_ICON = {
  approved: CheckIcon,
  rejected: XIcon,
  dismissed: ShieldQuestionIcon,
} as const

export const SquadGatePart = memo(function SquadGatePart({ part }: Props) {
  const t = useTranslations("squadRun.gate")
  const Icon = DECISION_ICON[part.decision] ?? ShieldQuestionIcon

  return (
    <div
      className="not-prose my-1.5 flex min-w-0 items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs"
      data-testid="squad-gate-part"
      data-decision={part.decision}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          part.decision === "approved" && "text-emerald-600",
          part.decision === "rejected" && "text-destructive",
          part.decision === "dismissed" && "text-muted-foreground"
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {/* The gate's own title, not a re-description of it — the reader saw
            that exact wording in the dialog they answered. */}
        {part.title}
      </span>
      <span className="shrink-0 text-muted-foreground">{t(`decision.${part.decision}`)}</span>
      <Link
        href={`/agent-runs?run=${encodeURIComponent(part.runId)}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        data-testid="squad-gate-open-run"
      >
        {t("openRun")}
      </Link>
    </div>
  )
})

export default SquadGatePart
