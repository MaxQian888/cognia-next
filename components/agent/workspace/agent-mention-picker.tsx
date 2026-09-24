"use client"

/**
 * Rows for the `@` sections of the chat composer's combined popover: a route
 * target (`@claude`, `@codex`, a Squad member — {@link AgentMentionRow}) and a
 * subagent ({@link SubagentMentionRow}). Designed to be dropped into
 * `<ComposerPopover>`'s list — same vertical rhythm, same hover/highlight
 * visuals — so the sections feel native rather than bolted on.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { fuzzyFilterSort } from "@/lib/chat/completion/fuzzy-match"
import { Badge } from "@/components/ui/badge"
import { RuntimeBadge, safeRuntimeLabel } from "./runtime-badge"
import { RUNTIME_LABEL_KEYS } from "./runtime-options"
import { AgentTeamAvatar, mentionTargetAvatarSubject } from "./agent-team-avatar"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import type { RouteLane } from "@/lib/chat/turn-route/types"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"
import type { Character } from "@cognia/agent-config-types"
import type { TeammateRuntime } from "@/types/agent/agent-team"

type Translator = ReturnType<typeof useTranslations>

/**
 * The display name of a runtime preset id: the team runtime labels where one
 * exists, the id itself otherwise (a plugin preset has no label of ours).
 */
export function routeRuntimeLabel(tRuntime: Translator, presetId: string | undefined): string {
  if (!presetId) return ""
  const key = RUNTIME_LABEL_KEYS[presetId as TeammateRuntime]
  return key ? safeRuntimeLabel(tRuntime, key, presetId) : presetId
}

/**
 * The one sentence that says why a route cannot run. Shared by the dimmed
 * popover row and the send-time refusal, so the two can never explain the same
 * lane differently.
 *
 * @param tRoute `chat.composer.route`
 * @param tRuntime `agentTeamsWorkspace.chat.runtime`
 */
export function routeFailureText(
  lane: Extract<RouteLane, { ok: false }>,
  target: Pick<MentionTarget, "handle" | "name">,
  tRoute: Translator,
  tRuntime: Translator
): string {
  const runtime = routeRuntimeLabel(tRuntime, lane.runtime)
  switch (lane.reason) {
    case "not-configured":
      return tRoute("notConfigured", { runtime })
    case "disabled":
      return tRoute("disabled")
    case "blocked":
      return lane.detail
        ? tRoute("blockedDetail", { runtime, detail: lane.detail })
        : tRoute("blocked", { runtime })
    case "transient":
      return lane.detail
        ? tRoute("startingDetail", { runtime, detail: lane.detail })
        : tRoute("starting", { runtime })
    case "member-missing":
      return tRoute("memberMissing", { handle: target.handle })
    case "member-runtime":
      return tRoute("memberRuntime", { name: target.name, runtime })
  }
}

export interface AgentMentionRowProps {
  target: MentionTarget
  /** Highlight (current arrow-key selection or hover). */
  highlighted?: boolean
  /**
   * The lane a turn addressed to this target would run on right now. A lane
   * that cannot run dims the row and says why; the row stays pickable, because
   * inserting the handle is harmless and the send path refuses it with the
   * same sentence and a way to fix it.
   */
  lane?: RouteLane
  /** The catalog row that would answer, when `lane` resolved to one. */
  descriptor?: AgentRuntimeDescriptor
}

export function AgentMentionRow({ target, highlighted, lane, descriptor }: AgentMentionRowProps) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  const tRoute = useTranslations("chat.composer.route")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  const tEngine = useTranslations("agentRuntime")
  const isVirtual = target.kind === "virtual"
  const unavailable = lane && !lane.ok ? lane : null

  // What the second line says: why it cannot run, else who will answer.
  let detail: string | null = null
  if (unavailable) {
    detail = routeFailureText(unavailable, target, tRoute, tRuntime)
  } else if (target.kind === "teammate") {
    detail = target.description || null
  } else if (descriptor?.group === "builtin" && descriptor.descriptionKey) {
    // `@claude` names the engine that will REALLY answer: the Anthropic SDK on
    // an Anthropic conversation, the AI SDK on every other provider.
    detail = tEngine(descriptor.descriptionKey, descriptor.descriptionValues ?? {})
  } else if (descriptor?.name) {
    detail = tRoute("runsOn", { name: descriptor.name })
  }

  return (
    <div
      data-testid={`agent-mention-row-${target.id}`}
      data-virtual={isVirtual ? "true" : "false"}
      data-unavailable={unavailable ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 text-sm",
        highlighted && "bg-accent text-accent-foreground",
        unavailable && "opacity-60"
      )}
    >
      <AgentTeamAvatar
        subject={mentionTargetAvatarSubject(target)}
        className="size-7 rounded-full bg-muted ring-1 ring-inset ring-border/60"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <span className="truncate">@{target.handle}</span>
          <RuntimeBadge runtime={target.runtime} />
          {isVirtual ? (
            <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
              {t("virtualTag")}
            </span>
          ) : (
            <span
              className="truncate rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground"
              data-testid={`agent-mention-row-squad-${target.id}`}
            >
              {target.squadName}
            </span>
          )}
        </span>
        {detail ? (
          <span
            className={cn(
              "truncate text-[11px]",
              unavailable ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
            )}
          >
            {detail}
          </span>
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
  return (
    <div
      data-testid={`subagent-mention-row-${target.id}`}
      className={cn(
        "flex w-full items-center gap-2 text-sm",
        highlighted && "bg-accent text-accent-foreground"
      )}
    >
      <AgentTeamAvatar
        subject={{ id: target.id, name: target.name, description: target.description }}
        className="size-7 rounded-full bg-muted ring-1 ring-inset ring-border/60"
      />
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
 * Filter route targets by query string using the shared fuzzy matcher — the
 * same scorer the slash-command picker uses, so `@` and `/` rank candidates
 * consistently. Matches against the `handle` (primary — what the pick inserts
 * and what the user is typing) and the name plus description (secondary,
 * demoted below any handle match). Stable order on ties / empty query:
 * virtuals first, then members by original order.
 */
export function filterMentionables(
  mentionables: readonly MentionTarget[],
  query: string
): MentionTarget[] {
  return fuzzyFilterSort(mentionables, query, (t) => t.handle, {
    secondaryText: (t) => `${t.name} ${t.description}`,
  })
}

/**
 * Rank a team room's members with the same fuzzy scorer, matching the character
 * name first (what a member pick inserts) and its description second. Shared by
 * the composer's `@` panel and a `{{parameter}}` bound to a member, so both
 * offer the same people in the same order.
 */
export function filterTeamMembers(members: readonly Character[], query: string): Character[] {
  return fuzzyFilterSort(members, query, (member) => member.name, {
    secondaryText: (member) => member.description ?? "",
  })
}
