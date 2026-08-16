"use client"

import type { ComponentType, ReactNode } from "react"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export interface SessionSettingsSectionProps {
  /** Stable id — used for `data-testid` and the aria relationship. */
  id: string
  title: string
  /** Optional one-line hint shown under the title when the section is collapsed. */
  summary?: string
  icon?: ComponentType<{ className?: string }>
  /**
   * Number of per-session overrides the section currently holds. Rendered as a
   * small count badge so a collapsed section still tells you it is customized.
   */
  overrideCount?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * When false the section renders with a static header — no chevron, no
   * toggle. Used for short sections whose content is always wanted (e.g. the
   * action row).
   */
  collapsible?: boolean
  className?: string
  contentClassName?: string
  children: ReactNode
}

/**
 * One flat block of the session settings sheet: icon + title header row, a
 * collapsed-state summary line, an override-count badge, and a chevron toggle.
 * Blocks stack with hairline dividers (the parent applies `divide-y`), no card
 * chrome. Radix Collapsible under the hood, so the content unmounts while
 * collapsed (cheap for the heavier subsections).
 */
export function SessionSettingsSection({
  id,
  title,
  summary,
  icon: Icon,
  overrideCount = 0,
  open,
  onOpenChange,
  collapsible = true,
  className,
  contentClassName,
  children,
}: SessionSettingsSectionProps) {
  const contentId = `session-settings-section-${id}-content`
  const header = (
    <>
      {Icon && (
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            overrideCount > 0 && "text-primary"
          )}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-sm font-medium leading-5">{title}</span>
        {!open && summary && (
          <span
            className="truncate text-[11px] leading-4 text-muted-foreground"
            data-testid={`session-settings-section-${id}-summary`}
          >
            {summary}
          </span>
        )}
      </span>
      {overrideCount > 0 && (
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center px-1.5 font-mono text-[10px] tabular-nums"
          data-testid={`session-settings-section-${id}-count`}
        >
          {overrideCount}
        </Badge>
      )}
    </>
  )

  if (!collapsible) {
    return (
      <section data-testid={`session-settings-section-${id}`} className={cn("py-1", className)}>
        <div className="flex items-center gap-2.5 px-4 py-2.5">{header}</div>
        <div className={cn("space-y-4 px-4 pb-4", contentClassName)}>{children}</div>
      </section>
    )
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-testid={`session-settings-section-${id}`}
      className={cn("py-1", className)}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-controls={contentId}
          className={cn(
            "flex w-full items-center gap-2.5 px-4 py-2.5 outline-none transition-colors",
            "hover:bg-muted/40 focus-visible:bg-muted/40"
          )}
        >
          {header}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </button>
      </CollapsibleTrigger>
      {/* Padding lives on the inner div: the height animation drives the
          content element from 0 → measured height, and padding on that element
          would stay visible at height 0. `motion-reduce` drops the animation. */}
      <CollapsibleContent
        id={contentId}
        className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none"
      >
        <div className={cn("space-y-4 px-4 pt-1 pb-4", contentClassName)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
