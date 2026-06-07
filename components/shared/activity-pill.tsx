"use client"

/**
 * Presentational pill for an ongoing background activity (goal loop, /loop
 * command) rendered above the chat composer. Purely visual — callers pass
 * already-translated strings and wired action callbacks, so the primitive
 * stays i18n-agnostic and domain-free.
 *
 * Responsive behavior (the reason this is shared): on mobile the secondary
 * actions collapse into a dropdown behind a ≥44px touch target and the
 * primary action stays inline at ≥44px; tablet/desktop render every action
 * inline at the compact desktop size. Callers keep their data-testids — the
 * same testid lands on the inline button or the menu item depending on the
 * breakpoint.
 */

import { MoreVerticalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useBreakpoint } from "@/hooks/ui/use-breakpoint"
import { cn } from "@/lib/utils"

export interface ActivityPillAction {
  id: string
  icon: React.ReactNode
  /** Translated label — doubles as the aria-label / menu item text. */
  label: string
  onClick: () => void
  testId?: string
  /** Primary actions stay inline on mobile instead of collapsing. */
  primary?: boolean
}

export interface ActivityPillChip {
  /** Translated status label. */
  label: string
  /** Tinted chip background + text classes (from the domain status style). */
  chipClassName: string
  /** Status dot fill class. */
  dotClassName: string
  /** Pulsing dot for "running" states. */
  pulse?: boolean
}

export interface ActivityPillProps {
  icon: React.ReactNode
  /** Translated one-line title (truncated). */
  title: string
  titleTooltip?: string
  chip: ActivityPillChip
  /** Progress line under the title. */
  subtext?: string
  /** Second muted line — e.g. "next continuation at 14:30". */
  footnote?: string
  actions: ActivityPillAction[]
  /** Translated aria-label for the whole pill. */
  ariaLabel: string
  /** Translated aria-label for the mobile overflow-menu trigger. */
  moreLabel: string
  className?: string
  "data-testid"?: string
}

export function ActivityPill({
  icon,
  title,
  titleTooltip,
  chip,
  subtext,
  footnote,
  actions,
  ariaLabel,
  moreLabel,
  className,
  "data-testid": testId,
}: ActivityPillProps) {
  const breakpoint = useBreakpoint()
  const isMobile = breakpoint === "mobile"
  const inlineActions = isMobile ? actions.filter((a) => a.primary) : actions
  const menuActions = isMobile ? actions.filter((a) => !a.primary) : []
  // ≥44px touch targets on mobile; compact icon buttons elsewhere.
  const buttonSize = isMobile ? "size-11" : "size-7"
  const iconSize = isMobile ? "size-4" : "size-3.5"

  return (
    <div
      data-testid={testId}
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs",
        className
      )}
    >
      <span className="shrink-0 text-primary" aria-hidden>
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium" title={titleTooltip ?? title}>
            {title}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              chip.chipClassName
            )}
          >
            <span className="relative flex size-1.5">
              {chip.pulse && (
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                    chip.dotClassName
                  )}
                />
              )}
              <span
                className={cn("relative inline-flex size-1.5 rounded-full", chip.dotClassName)}
              />
            </span>
            {chip.label}
          </span>
        </div>
        {subtext ? <span className="text-[10px] text-muted-foreground">{subtext}</span> : null}
        {footnote ? (
          <span className="text-[10px] text-muted-foreground" data-testid="activity-pill-footnote">
            {footnote}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {inlineActions.map((action) => (
          <Button
            key={action.id}
            size="icon"
            variant="ghost"
            className={buttonSize}
            aria-label={action.label}
            data-testid={action.testId}
            onClick={action.onClick}
          >
            <span className={cn("[&>svg]:size-full", iconSize)} aria-hidden>
              {action.icon}
            </span>
          </Button>
        ))}
        {menuActions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={buttonSize}
                aria-label={moreLabel}
                data-testid="activity-pill-more"
              >
                <MoreVerticalIcon className={iconSize} aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menuActions.map((action) => (
                <DropdownMenuItem
                  key={action.id}
                  data-testid={action.testId}
                  onClick={action.onClick}
                  className="min-h-11 gap-2"
                >
                  <span className="[&>svg]:size-4" aria-hidden>
                    {action.icon}
                  </span>
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

ActivityPill.displayName = "ActivityPill"
