"use client"

/**
 * Horizontal row of one-click mention chips above the team workspace
 * composer. Each chip expands to a 24×24 colored avatar + the agent name +
 * the runtime badge. Clicking a chip inserts `@<name>` at the textarea
 * caret via the `onPick` callback (the workspace forwards this to the
 * Composer's imperative `insertMention` handle).
 *
 * Used at the bottom of the chat tab so the user can drop into a real
 * conversation without remembering exact teammate names.
 */

import { Button } from "@/components/ui/button"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { RuntimeBadge } from "./runtime-badge"
import { AgentTeamAvatar, mentionTargetAvatarSubject } from "./agent-team-avatar"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { RuntimeAvailabilityMap } from "@/lib/agent-team/use-runtime-availability"

export interface TeamMentionChipsProps {
  targets: readonly MentionTarget[]
  onPick: (target: MentionTarget) => void
  className?: string
  /**
   * Optional availability map. When provided, chips for unavailable runtimes
   * dim their visuals and surface a tooltip explaining the missing setup.
   * Partial — callers may supply a subset of runtimes; absent ones default to
   * "ready" (see the `?? "ready"` fallback below).
   */
  availability?: Partial<RuntimeAvailabilityMap>
}

export function TeamMentionChips({
  targets,
  onPick,
  className,
  availability,
}: TeamMentionChipsProps) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  const tStatus = useTranslations("agentTeamsWorkspace.chat.runtimeStatus")
  if (targets.length === 0) return null
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid="team-mention-chips">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("mentionAgents")}
      </span>
      <ScrollArea className="w-full">
        <div className="flex w-max items-center gap-1.5 pb-1.5">
          {targets.map((target) => {
            const status = availability?.[target.runtime] ?? "ready"
            const unavailable = status !== "ready"
            const tooltip = statusTooltip(status, target.runtime, tStatus)
            return (
              <Button
                key={target.id}
                type="button"
                variant="outline"
                size="sm"
                data-testid={`mention-chip-${target.id}`}
                data-runtime-status={status}
                title={tooltip}
                onClick={() => onPick(target)}
                className={cn(
                  // Match the composer's soft-filled pill family (rounded-md +
                  // muted fill + soft border) so in-box @mentions and these
                  // one-click chips read as one visual language.
                  "h-7 shrink-0 gap-1.5 rounded-md bg-muted/40 px-2 text-xs hover:bg-muted hover:text-foreground",
                  unavailable && "opacity-60"
                )}
              >
                <AgentTeamAvatar
                  subject={mentionTargetAvatarSubject(target)}
                  className="size-4 rounded-full bg-muted ring-1 ring-inset ring-border/60"
                />
                <span className="font-medium">@{target.name}</span>
                <RuntimeBadge runtime={target.runtime} iconOnly className="h-4 w-4 px-0" />
                {unavailable && <AlertTriangleIcon className="size-3 text-amber-500" aria-hidden />}
              </Button>
            )
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}

function statusTooltip(
  status: string,
  runtime: string,
  t: (key: string, params?: Record<string, string>) => string
): string {
  switch (status) {
    case "missing-key":
      return t("missingKey")
    case "no-agent":
      return t("noAgent", { runtime })
    case "disconnected":
      return t("disconnected", { runtime })
    default:
      return ""
  }
}
