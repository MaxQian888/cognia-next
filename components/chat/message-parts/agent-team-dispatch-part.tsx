"use client"

/**
 * AgentTeamDispatchPart renderer — visualises a single
 * `<dispatch to="...">...</dispatch>` directive parsed out of a supervisor
 * turn. Renders as a banner with from→to arrow, the task body (markdown),
 * and a link to the addressed teammate's panel.
 *
 * Phase 8 of the ClaudeCode 完整化 plan.
 */

import { memo } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { AgentTeamDispatchPart as DispatchPartType } from "@/lib/claude/parts-extensions"
import type { AgentFlowMode } from "@/types/appearance"
import { cn } from "@/lib/utils"

interface Props {
  part: DispatchPartType
  fromName?: string
  /** Display mode; `simplified` drops the task body to stay compact. */
  mode?: AgentFlowMode
}

export const AgentTeamDispatchPart = memo(function AgentTeamDispatchPart({
  part,
  fromName,
  mode = "standard",
}: Props) {
  const t = useTranslations("chat.agentTeamDispatch")
  const compact = mode === "simplified"
  const memberHref = `/agent-teams?focus=${part.to}`
  return (
    <Card
      className={cn(
        "not-prose border-l-4 border-l-primary",
        compact ? "my-1 px-3 py-1.5" : "my-2 p-3"
      )}
      data-testid={`agent-team-dispatch-${part.to}`}
      data-mode={mode}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <UsersIcon className="size-3 shrink-0" aria-hidden />
        <span className="font-medium">{fromName ?? t("supervisor")}</span>
        <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
        <Badge variant="secondary" className="text-[10px]" data-testid="dispatch-to">
          {part.toName}
        </Badge>
        {compact ? (
          <Link
            href={memberHref}
            className="ml-auto inline-flex items-center gap-1 underline"
            data-testid="dispatch-open"
          >
            {t("openMember")}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
      {compact ? null : (
        <>
          <p className="mt-1 whitespace-pre-wrap text-xs">{part.task}</p>
          <Link
            href={memberHref}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] underline"
            data-testid="dispatch-open"
          >
            {t("openMember")}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </Link>
        </>
      )}
    </Card>
  )
})
