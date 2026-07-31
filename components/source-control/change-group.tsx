"use client"

/**
 * A collapsible group header (Merge / Staged / Changes) with a count badge and
 * hover-reveal group-level actions (e.g. stage-all / unstage-all / discard-all).
 */

import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GitStatusGroup } from "@/types/git"

export interface GroupAction {
  key: string
  label: string
  icon: React.ReactNode
  onClick: () => void
  destructive?: boolean
}

interface ChangeGroupProps {
  group: GitStatusGroup
  count: number
  expanded: boolean
  onToggle: () => void
  actions?: GroupAction[]
  children: React.ReactNode
  density?: "compact" | "touch"
}

export function ChangeGroup({
  group,
  count,
  expanded,
  onToggle,
  actions = [],
  children,
  density = "compact",
}: ChangeGroupProps) {
  const t = useTranslations("sourceControl")
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <section data-testid={`change-group-${group}`}>
      <div
        className={cn(
          "group/header flex h-7 items-center gap-1 px-1",
          density === "touch" && "h-auto min-h-11"
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground",
            density === "touch" && "min-h-11"
          )}
          data-testid={`group-toggle-${group}`}
        >
          <Chevron className="size-3.5 shrink-0" />
          <span className="truncate">{t(`groups.${group}`)}</span>
          <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
            {count}
          </Badge>
        </button>
        <span
          className={cn(
            "flex shrink-0 items-center opacity-0 transition-opacity group-hover/header:opacity-100",
            density === "touch" && "opacity-100"
          )}
        >
          {actions.map((action) => (
            <Button
              key={action.key}
              variant="ghost"
              size="icon"
              className={cn(
                "size-5",
                density === "touch" && "size-11",
                action.destructive && "text-destructive"
              )}
              aria-label={action.label}
              title={action.label}
              onClick={action.onClick}
              data-testid={`group-action-${group}-${action.key}`}
            >
              {action.icon}
            </Button>
          ))}
        </span>
      </div>
      {expanded && <div className="flex flex-col">{children}</div>}
    </section>
  )
}
