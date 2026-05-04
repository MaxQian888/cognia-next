"use client"

/**
 * AgentTeamDispatchPart renderer — visualises a single
 * `<dispatch to="...">...</dispatch>` directive parsed out of a supervisor
 * turn. Renders as a banner with from→to arrow, the task body (markdown),
 * and a link to the addressed teammate's panel.
 *
 * Phase 8 of the ClaudeCode 完整化 plan.
 */

import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { AgentTeamDispatchPart as DispatchPartType } from "@/lib/claude/parts-extensions"

interface Props {
  part: DispatchPartType
  fromName?: string
}

export function AgentTeamDispatchPart({ part, fromName }: Props) {
  const t = useTranslations("chat.agentTeamDispatch")
  return (
    <Card
      className="not-prose my-2 border-l-4 border-l-primary p-3"
      data-testid={`agent-team-dispatch-${part.to}`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <UsersIcon className="size-3" />
        <span className="font-medium">{fromName ?? t("supervisor")}</span>
        <ArrowRightIcon className="size-3" />
        <Badge variant="secondary" className="text-[10px]" data-testid="dispatch-to">
          {part.toName}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap text-xs">{part.task}</p>
      <Link
        href={`/agent-teams?focus=${part.to}`}
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] underline"
        data-testid="dispatch-open"
      >
        {t("openMember")}
        <ExternalLinkIcon className="size-3" />
      </Link>
    </Card>
  )
}
