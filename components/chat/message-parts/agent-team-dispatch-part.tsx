"use client"

/**
 * AgentTeamDispatchPart renderer — visualises a single
 * `<dispatch to="...">...</dispatch>` directive parsed out of a supervisor
 * turn. Renders as a banner with from→to arrow, the task body (markdown),
 * and a link to the addressed teammate's panel.
 *
 * Phase 8 of the ClaudeCode 完整化 plan.
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ToolRowShell } from "@/components/chat/message-parts/tool-row"
import type { AgentTeamDispatchPart as DispatchPartType } from "@/lib/claude/parts-extensions"
import type { AgentFlowMode } from "@/types/appearance"

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
  // Standard shows the task by default — a dispatch exists to be read;
  // simplified drops the body entirely (static row, link only).
  const [open, setOpen] = useState(true)
  // `part.to` is a CHARACTER id, not a squad. This used to point at
  // `/agent-teams?focus=<character>`, a retired route with a parameter nothing
  // read, so the link went to a page that could not honour it. Characters live
  // in Discover, which takes `?category=…&item=…`.
  const memberHref = `/discover?category=characters&item=${encodeURIComponent(part.to)}`
  return (
    <div data-testid={`agent-team-dispatch-${part.to}`} data-mode={mode}>
      <ToolRowShell
        className={compact ? "my-1" : "my-2"}
        status="complete"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel={t("supervisor")}
        testId={`agent-team-dispatch-row-${part.to}`}
        lead={
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <UsersIcon className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 max-w-[40%] truncate font-medium">
              {fromName ?? t("supervisor")}
            </span>
            <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
            <Badge
              variant="secondary"
              className="max-w-[45%] truncate text-[10px]"
              data-testid="dispatch-to"
            >
              {part.toName}
            </Badge>
          </span>
        }
        target={<span className="flex-1" />}
        actions={
          <Link
            href={memberHref}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
            data-testid="dispatch-open"
            onClick={(e) => e.stopPropagation()}
          >
            {t("openMember")}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </Link>
        }
      >
        {compact ? null : (
          <div className="mb-1 border-l pl-3 pt-1">
            <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs">
              {part.task}
            </p>
          </div>
        )}
      </ToolRowShell>
    </div>
  )
})
