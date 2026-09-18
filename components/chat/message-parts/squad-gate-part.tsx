"use client"

/**
 * A gate that was answered, recorded where the decision applies.
 *
 * Compact by design — one static status line in the shared row language
 * (status dot + title + decision + open-run hover action). This is a receipt,
 * not an event the reader needs to act on: by the time it renders, the
 * decision is already made and the run has moved on. Its job is to make "what
 * did I approve, and when" answerable later, which a dismissed modal cannot
 * do.
 */

import { memo } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { CheckIcon, ExternalLinkIcon, ShieldQuestionIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import type { SquadGatePart as SquadGatePartType } from "@/lib/claude/parts-extensions"

interface Props {
  part: SquadGatePartType
}

const DECISION_ICON = {
  approved: CheckIcon,
  rejected: XIcon,
  dismissed: ShieldQuestionIcon,
} as const

const DECISION_DOT: Record<string, ToolDotStatus> = {
  approved: "complete",
  rejected: "error",
  dismissed: "pending",
}

export const SquadGatePart = memo(function SquadGatePart({ part }: Props) {
  const t = useTranslations("squadRun.gate")
  const Icon = DECISION_ICON[part.decision] ?? ShieldQuestionIcon

  return (
    <div data-testid="squad-gate-part" data-decision={part.decision}>
      <ToolRowShell
        className="my-1.5"
        status={DECISION_DOT[part.decision] ?? "pending"}
        ariaLabel={part.title}
        testId="squad-gate-row"
        lead={
          <Icon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              part.decision === "approved" && "text-emerald-600",
              part.decision === "rejected" && "text-destructive",
              part.decision === "dismissed" && "text-muted-foreground"
            )}
          />
        }
        target={
          // The gate's own title, not a re-description of it — the reader saw
          // that exact wording in the dialog they answered.
          <span className="min-w-0 flex-1 truncate text-xs">{part.title}</span>
        }
        meta={
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(`decision.${part.decision}`)}
          </span>
        }
        actions={
          <Link
            href={`/agent-runs?run=${encodeURIComponent(part.runId)}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="squad-gate-open-run"
          >
            {t("openRun")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </Link>
        }
      />
    </div>
  )
})

export default SquadGatePart
