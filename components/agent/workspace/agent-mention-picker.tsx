"use client"

/**
 * Renders a single agent row inside the chat composer's popover when in
 * `mentionMode="agents"`. Designed to be dropped into `<ComposerPopover>`'s
 * list — same vertical rhythm, same hover/highlight visuals — so the agent
 * picker feels native rather than bolted on.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { senderColor } from "./sender-color"
import { RuntimeBadge } from "./runtime-badge"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

export interface AgentMentionRowProps {
  target: MentionTarget
  /** Highlight (current arrow-key selection or hover). */
  highlighted?: boolean
}

export function AgentMentionRow({ target, highlighted }: AgentMentionRowProps) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  const initial = target.name.charAt(0).toUpperCase() || "?"
  const isVirtual = target.kind === "virtual"

  return (
    <div
      data-testid={`agent-mention-row-${target.id}`}
      data-virtual={isVirtual ? "true" : "false"}
      className={cn(
        "flex w-full items-center gap-2 text-sm",
        highlighted && "bg-accent text-accent-foreground"
      )}
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ backgroundColor: senderColor(target.name) }}
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-xs font-medium">
          <span className="truncate">@{target.name}</span>
          <RuntimeBadge runtime={target.runtime} />
          {isVirtual && (
            <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
              {t("virtualTag")}
            </span>
          )}
        </span>
        {target.description ? (
          <span className="truncate text-[11px] text-muted-foreground">{target.description}</span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Filter mentionables by query string. Matches against the `name` (case-
 * insensitive prefix preferred, substring as fallback) and description.
 * Stable order: virtuals first, then teammates by original order.
 */
export function filterMentionables(
  mentionables: readonly MentionTarget[],
  query: string
): MentionTarget[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...mentionables]
  return mentionables
    .map((t) => {
      const name = t.name.toLowerCase()
      const desc = t.description.toLowerCase()
      let score = -1
      if (name.startsWith(q)) score = 1000 - name.length
      else if (name.includes(q)) score = 800 - name.length
      else if (desc.includes(q)) score = 100
      return { target: t, score }
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.target)
}
