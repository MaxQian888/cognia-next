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
import { senderColor } from "./sender-color"
import { RuntimeBadge } from "./runtime-badge"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { RuntimeAvailabilityMap } from "@/lib/agent-team/use-runtime-availability"

export interface TeamMentionChipsProps {
  targets: readonly MentionTarget[]
  onPick: (target: MentionTarget) => void
  className?: string
  /**
   * Optional availability map. When provided, chips for unavailable runtimes
   * dim their visuals and surface a tooltip explaining the missing setup.
   */
  availability?: RuntimeAvailabilityMap
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
                  "h-7 shrink-0 gap-1.5 rounded-full px-2 text-xs",
                  unavailable && "opacity-60"
                )}
              >
                <span
                  aria-hidden
                  className="flex size-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                  style={{ backgroundColor: senderColor(target.name) }}
                >
                  {target.name.charAt(0).toUpperCase() || "?"}
                </span>
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
      return safeT(t, "missingKey", "Set an Anthropic API key in Settings → Providers")
    case "no-agent":
      return safeT(
        t,
        "noAgent",
        `No external agent configured for ${runtime}. Add one in Settings → External Agents.`,
        { runtime }
      )
    case "disconnected":
      return safeT(
        t,
        "disconnected",
        `${runtime} is configured but not connected. Open Settings → External Agents to connect.`,
        { runtime }
      )
    default:
      return ""
  }
}

function safeT(
  t: (key: string, params?: Record<string, string>) => string,
  key: string,
  fallback: string,
  params?: Record<string, string>
): string {
  try {
    const value = t(key, params)
    if (value && value !== key) return value
  } catch {
    /* fall through */
  }
  return fallback
}
