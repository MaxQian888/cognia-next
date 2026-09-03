"use client"

import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import { MoreHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * How the header meets the page.
 *
 *  - `management` — the full-bleed band every feature route uses
 *  - `compact`    — the same band at column-header height
 *  - `card`       — a bordered, rounded block with a gap beneath it, for
 *                   scrolling document pages that have no band to sit in
 *
 * `card` exists because three call sites were already producing it by passing
 * `className="rounded-xl border shadow-sm"`, and a fourth header component in
 * `settings/common/settings-section.tsx` had reimplemented the same look — same
 * gradient hairline, same `size-9 rounded-xl` icon tile — as a separate
 * component (ADR-0148).
 */
export type FeaturePageHeaderVariant = "management" | "compact" | "card"

/**
 * Where `navigation` renders.
 *
 * `"secondary"` (the default, and what every existing page uses) gives
 * navigation its own row under the identity row. `"inline"` folds it into the
 * identity row instead, which is the right call when the nav is a short tab
 * set and the page cannot afford a second band of chrome — the header then
 * collapses to a single row unless `controls` are also supplied.
 */
export type FeatureHeaderNavigationPlacement = "secondary" | "inline"

export interface FeatureHeaderAction {
  id: string
  label: string
  icon?: LucideIcon
  href?: string
  onSelect?: () => void
  disabled?: boolean
  destructive?: boolean
  testId?: string
}

export interface FeaturePageHeaderProps {
  variant?: FeaturePageHeaderVariant
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  context?: React.ReactNode
  breadcrumb?: React.ReactNode
  status?: React.ReactNode
  summary?: React.ReactNode
  navigation?: React.ReactNode
  /** Defaults to `"secondary"`. See {@link FeatureHeaderNavigationPlacement}. */
  navigationPlacement?: FeatureHeaderNavigationPlacement
  controls?: React.ReactNode
  primaryAction?: FeatureHeaderAction
  secondaryActions?: readonly FeatureHeaderAction[]
  overflowActions?: readonly FeatureHeaderAction[]
  overflowLabel?: string
  actions?: React.ReactNode
  /**
   * Which heading element the title renders as. Defaults to `1` — a feature
   * route's header IS the page title. A header nested inside a page that
   * already has one (a settings section, for instance) must pass `2`, or the
   * document ends up with two `h1`s.
   */
  headingLevel?: 1 | 2
  className?: string
  testId?: string
}

function ActionIcon({ action }: { action: FeatureHeaderAction }) {
  const Icon = action.icon
  return Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null
}

function HeaderActionButton({
  action,
  primary = false,
  responsive = false,
}: {
  action: FeatureHeaderAction
  primary?: boolean
  responsive?: boolean
}) {
  const content = (
    <>
      <ActionIcon action={action} />
      <span className={cn(responsive && action.icon && "hidden @2xl/feature-header:inline")}>
        {action.label}
      </span>
    </>
  )
  const button = (
    <Button
      asChild={Boolean(action.href)}
      type={action.href ? undefined : "button"}
      variant={action.destructive ? "destructive" : primary ? "default" : "outline"}
      size="sm"
      disabled={action.disabled}
      onClick={action.href ? undefined : action.onSelect}
      aria-label={action.label}
      data-testid={action.testId}
      className={cn(
        "motion-safe:transition-[background-color,color,box-shadow,transform] motion-safe:duration-200",
        primary && "shadow-sm shadow-primary/15",
        responsive &&
          action.icon &&
          "size-8 px-0 @2xl/feature-header:h-8 @2xl/feature-header:w-auto @2xl/feature-header:px-3"
      )}
    >
      {action.href ? <Link href={action.href}>{content}</Link> : content}
    </Button>
  )

  if (!responsive || !action.icon) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  )
}

function OverflowActionItem({ action }: { action: FeatureHeaderAction }) {
  const content = (
    <>
      <ActionIcon action={action} />
      <span>{action.label}</span>
    </>
  )

  if (action.href) {
    return (
      <DropdownMenuItem asChild disabled={action.disabled}>
        <Link href={action.href} data-testid={action.testId}>
          {content}
        </Link>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuItem
      disabled={action.disabled}
      variant={action.destructive ? "destructive" : "default"}
      onSelect={action.onSelect}
      data-testid={action.testId}
    >
      {content}
    </DropdownMenuItem>
  )
}

export function FeaturePageHeader({
  variant = "management",
  icon,
  title,
  description,
  context,
  breadcrumb,
  status,
  summary,
  navigation,
  navigationPlacement = "secondary",
  controls,
  primaryAction,
  secondaryActions = [],
  overflowActions = [],
  overflowLabel,
  actions,
  headingLevel = 1,
  className,
  testId,
}: FeaturePageHeaderProps) {
  const inlineNavigation = navigationPlacement === "inline" ? navigation : null
  const secondaryNavigation = navigationPlacement === "inline" ? null : navigation
  const hasSecondary = Boolean(secondaryNavigation || controls)
  const showOverflow = overflowActions.length > 0 && Boolean(overflowLabel)
  const Heading = headingLevel === 2 ? "h2" : "h1"
  const isCompact = variant === "compact"
  const isCard = variant === "card"

  return (
    <header
      data-slot="feature-page-header"
      data-testid={testId}
      data-variant={variant}
      data-elevation={isCard ? "1" : undefined}
      data-has-secondary={String(hasSecondary)}
      data-navigation-placement={navigationPlacement}
      className={cn(
        "@container/feature-header relative z-10 shrink-0 overflow-hidden border-border/70 bg-background/88 text-foreground backdrop-blur-xl supports-[backdrop-filter]:bg-background/76",
        isCard ? "mb-5 rounded-stage border" : "border-b",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/35 before:to-transparent",
        className
      )}
    >
      <div
        className={cn(
          "relative flex min-w-0 items-center gap-2.5 px-3 @md/feature-header:px-4",
          isCompact ? "min-h-[var(--chrome-h)] py-1" : "min-h-[var(--chrome-h-tall)] py-2"
        )}
      >
        {breadcrumb ? (
          <div
            // Same contract as the two navigation slots and `controls`. This
            // was the fourth slot and the only one that could neither shrink
            // nor scroll: the header is `overflow-hidden` and `actions` is
            // `shrink-0`, so a breadcrumb that refuses to give way pushes the
            // actions past the edge, where they are clipped rather than
            // wrapped. Source Control fills this slot with a root switcher AND
            // a root chip, and lost buttons off its right edge for it.
            className="flex min-w-0 shrink items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-slot="feature-header-breadcrumb"
          >
            {breadcrumb}
          </div>
        ) : null}

        {icon ? (
          <span
            className={cn(
              "grid shrink-0 place-items-center border border-primary/15 bg-gradient-to-br from-primary/14 via-primary/8 to-background text-primary shadow-xs",
              isCompact ? "size-7 rounded-lg [&_svg]:size-3.5" : "size-9 rounded-xl [&_svg]:size-4"
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Heading
              className={cn(
                "truncate font-semibold tracking-tight",
                isCompact ? "text-sm" : "text-base @xl/feature-header:text-[17px]"
              )}
            >
              {title}
            </Heading>
            {status ? (
              <div className="hidden shrink-0 @md/feature-header:block">{status}</div>
            ) : null}
          </div>
          {!isCompact && (description || context) ? (
            <div className="mt-0.5 hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @lg/feature-header:flex">
              {description ? <span className="truncate">{description}</span> : null}
              {description && context ? (
                <span className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />
              ) : null}
              {context ? <span className="shrink-0">{context}</span> : null}
            </div>
          ) : null}
        </div>

        {inlineNavigation ? (
          <div
            // Shrinks rather than holding its content width. The header is
            // `overflow-hidden`, and the actions to its right are `shrink-0`,
            // so a nav that refuses to give way pushes them past the edge and
            // they are clipped, not wrapped: at 375px /logs lost both its
            // refresh and overflow buttons that way. Yielding here moves the
            // spill inside this box, where the scroll can reach it.
            className="min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-slot="feature-header-inline-navigation"
          >
            {inlineNavigation}
          </div>
        ) : null}

        {summary ? (
          <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground @3xl/feature-header:flex">
            {summary}
          </div>
        ) : null}

        <div
          className="flex shrink-0 items-center gap-1.5 @md/feature-header:gap-2"
          data-testid="feature-header-actions"
        >
          {actions}
          {secondaryActions.map((action) => (
            <HeaderActionButton key={action.id} action={action} responsive />
          ))}
          {showOverflow ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={overflowLabel}
                  className="motion-safe:transition-colors motion-safe:duration-200"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {overflowActions.map((action) => (
                  <OverflowActionItem key={action.id} action={action} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {primaryAction ? <HeaderActionButton action={primaryAction} primary /> : null}
        </div>
      </div>

      {hasSecondary ? (
        <div className="relative flex min-h-[var(--chrome-h)] min-w-0 items-center gap-2 border-t border-border/55 bg-muted/16 px-3 py-1.5 @md/feature-header:px-4">
          {secondaryNavigation ? (
            <div
              // Same contract as the inline slot and as `controls` below. This
              // was the one of the three that could neither shrink nor scroll,
              // so a tab set wider than the row was simply cut off by the
              // header's `overflow-hidden`: /eval shipped four tabs of which
              // two could not be reached at 375px.
              className="min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-slot="feature-header-secondary-navigation"
            >
              {secondaryNavigation}
            </div>
          ) : null}
          {secondaryNavigation && controls ? (
            <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden="true" />
          ) : null}
          {controls ? (
            <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {controls}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
