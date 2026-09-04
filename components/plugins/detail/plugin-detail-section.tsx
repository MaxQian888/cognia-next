"use client"

// Collapsible section used by the README-centric detail pane. Each section
// (Capabilities / Configure / Permissions / Data / Logs) is controlled by the
// store's `detailSubTab`: exactly one section is open at a time, and a
// `?subtab=` deep link auto-expands the matching section. Replaces the old
// flat tab strip so the README/overview stays the reading-first body.

import type { ComponentType, ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

interface Props {
  icon: ComponentType<{ className?: string }>
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  testId?: string
  children: ReactNode
}

export function PluginDetailSection({
  icon: Icon,
  title,
  open,
  onOpenChange,
  testId,
  children,
}: Props) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="rounded-md border">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-sm font-medium",
          "transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
          open && "border-b"
        )}
        data-testid={testId}
        data-state={open ? "open" : "closed"}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">{title}</span>
        <ChevronRightIcon
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 py-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

interface LinkProps {
  icon: ComponentType<{ className?: string }>
  title: string
  href: string
  /** Short line under the title saying where the link goes. */
  description?: string
  testId?: string
}

/**
 * A section row that leaves the pane instead of expanding.
 *
 * Same chrome as `PluginDetailSection` so the list of sections reads as one
 * ladder, with a different affordance glyph because the outcome is different:
 * this one navigates. Used by Logs, which is owned by the log panel rather
 * than by a second reader living in this pane.
 */
export function PluginDetailSectionLink({
  icon: Icon,
  title,
  href,
  description,
  testId,
}: LinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium",
        "transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
      )}
      data-testid={testId}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate">{title}</span>
        {description ? (
          <span className="truncate text-xs font-normal text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}
