"use client"

// Collapsible section used by the README-centric detail pane. Each section
// (Capabilities / Configure / Permissions / Data / Logs) is controlled by the
// store's `detailSubTab`: exactly one section is open at a time, and a
// `?subtab=` deep link auto-expands the matching section. Replaces the old
// flat tab strip so the README/overview stays the reading-first body.

import type { ComponentType, ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
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
          "flex w-full items-center gap-2 px-3 py-2 text-sm font-medium",
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
      <CollapsibleContent className="p-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}
