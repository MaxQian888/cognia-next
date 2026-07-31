"use client"

/**
 * Renders a single agent row inside the chat composer's popover when in
 * `mentionMode="agents"`. Designed to be dropped into `<ComposerPopover>`'s
 * list — same vertical rhythm, same hover/highlight visuals — so the agent
 * picker feels native rather than bolted on.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { fuzzyFilterSort } from "@/lib/chat/completion/fuzzy-match"
import { Badge } from "@/components/ui/badge"
import { senderColor } from "./sender-color"
import { RuntimeBadge } from "./runtime-badge"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"

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

export interface SubagentMentionRowProps {
  target: SubagentMentionTarget
  /** Highlight (current arrow-key selection or hover). */
  highlighted?: boolean
}

/**
 * Row for a `@`-mentionable SUBAGENT in the general chat composer's combined
 * popover. Mirrors {@link AgentMentionRow}'s rhythm/visuals (avatar + name +
 * description) but shows a MODEL badge (the subagent's identity is a model, not
 * a team runtime) instead of the team `RuntimeBadge`.
 */
export function SubagentMentionRow({ target, highlighted }: SubagentMentionRowProps) {
  const initial = target.name.charAt(0).toUpperCase() || "?"
  return (
    <div
      data-testid={`subagent-mention-row-${target.id}`}
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
          <span className="truncate">@{target.handle}</span>
          {target.model ? (
            <Badge variant="secondary" className="px-1 text-[9px]">
              {target.model}
            </Badge>
          ) : null}
        </span>
        {target.description ? (
          <span className="truncate text-[11px] text-muted-foreground">{target.description}</span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Filter subagent mention targets by query using the shared fuzzy matcher,
 * matching the picked-handle (primary) + description (secondary) so the search
 * lines up with what gets inserted (`@<handle>`).
 */
export function filterSubagents(
  targets: readonly SubagentMentionTarget[],
  query: string
): SubagentMentionTarget[] {
  return fuzzyFilterSort(targets, query, (t) => t.handle, {
    secondaryText: (t) => t.description,
  })
}

/**
 * Filter mentionables by query string using the shared fuzzy matcher — the
 * same scorer the slash-command picker uses, so `@` and `/` rank candidates
 * consistently. Matches against the `name` (primary) and `description`
 * (secondary, demoted below any name match). Stable order on ties / empty
 * query: virtuals first, then teammates by original order.
 */
export function filterMentionables(
  mentionables: readonly MentionTarget[],
  query: string
): MentionTarget[] {
  return fuzzyFilterSort(mentionables, query, (t) => t.name, {
    secondaryText: (t) => t.description,
  })
}
