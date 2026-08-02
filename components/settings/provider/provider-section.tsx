"use client"

import React from "react"
import { ChevronDown } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/**
 * Flat section header used across the provider detail pane.
 *
 * The Diagnostics and Advanced tabs used to be built out of `Card`s, which put
 * a bordered, elevated box inside a bordered pane inside a bordered panel —
 * three nested frames deep before any actual content, and visually unrelated to
 * the Config tab right next to it, which is plain stacked sections separated by
 * hairlines. This primitive is that Config idiom, extracted: a heading row, an
 * optional description, an optional action slot, and a hairline underneath.
 *
 * `collapsible` keeps the affordance that genuinely earned its keep on the long
 * sections (balance, endpoints, history) — flattening is about removing the box,
 * not about forcing every section permanently open.
 */
export interface ProviderSectionProps {
  /** Lucide-style icon rendered before the title. */
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned slot (filters, buttons). Never inside the collapsible trigger. */
  actions?: React.ReactNode
  /** Small pill after the title — a count, a status. */
  badge?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /** Content wrapper class. */
  contentClassName?: string
  /** Render the heading as a disclosure trigger. */
  collapsible?: boolean
  /** Only meaningful with `collapsible`. */
  defaultOpen?: boolean
  /** Drop the trailing hairline (last section in a stack sets this implicitly). */
  hideSeparator?: boolean
  "data-testid"?: string
}

function SectionHeading({
  icon: Icon,
  title,
  description,
  badge,
}: Pick<ProviderSectionProps, "icon" | "title" | "description" | "badge">) {
  return (
    <div className="min-w-0 flex-1 text-left">
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate text-sm font-medium">{title}</span>
        {badge}
      </div>
      {description && (
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

export function ProviderSection({
  icon,
  title,
  description,
  actions,
  badge,
  children,
  className,
  contentClassName,
  collapsible = false,
  defaultOpen = true,
  hideSeparator = false,
  "data-testid": testId,
}: ProviderSectionProps) {
  const frame = cn(
    "min-w-0 pb-5",
    !hideSeparator && "border-b last:border-b-0 last:pb-0",
    hideSeparator && "pb-0",
    className
  )

  if (!collapsible) {
    return (
      <section className={frame} data-testid={testId}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <SectionHeading icon={icon} title={title} description={description} badge={badge} />
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children && <div className={cn("mt-3 min-w-0", contentClassName)}>{children}</div>}
      </section>
    )
  }

  return (
    <Collapsible defaultOpen={defaultOpen} className={frame} data-testid={testId} asChild>
      <section>
        {/* The action slot sits beside the trigger, not inside it — nesting a
            button inside a button is invalid HTML and swallows the click. */}
        <div className="flex min-w-0 items-start gap-2">
          <CollapsibleTrigger className="group/section flex min-w-0 flex-1 items-start gap-2 rounded-md py-0.5 text-left transition-colors hover:text-foreground">
            <SectionHeading icon={icon} title={title} description={description} badge={badge} />
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/section:rotate-180" />
          </CollapsibleTrigger>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        <CollapsibleContent className={cn("mt-3 min-w-0", contentClassName)}>
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** Stack wrapper: consistent rhythm between flat sections. */
export function ProviderSectionStack({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn("flex min-w-0 flex-col gap-5", className)}>{children}</div>
}
