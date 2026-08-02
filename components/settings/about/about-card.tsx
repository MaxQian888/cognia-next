"use client"

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface AboutCardProps {
  /** Leading glyph rendered inside the tinted plate. */
  icon: LucideIcon
  title: string
  /** Optional trailing header slot (status badge, inline action). */
  action?: ReactNode
  testid?: string
  className?: string
  contentClassName?: string
  children: ReactNode
}

/**
 * Shared chrome for every About card: a tinted header rail with an icon plate
 * and title, and a padded body. Centralising it keeps the six cards visually
 * identical and lets the section grid treat them as interchangeable tiles.
 */
export function AboutCard({
  icon: Icon,
  title,
  action,
  testid,
  className,
  contentClassName,
  children,
}: AboutCardProps) {
  return (
    <Card
      data-testid={testid}
      className={cn(
        "h-full gap-0 overflow-hidden py-0 transition-colors duration-200 hover:border-foreground/15",
        className
      )}
    >
      <CardHeader className="flex flex-row items-center gap-3 border-b bg-muted/40 px-4 py-3 sm:px-5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-sm"
        >
          <Icon className="size-4" />
        </span>
        <CardTitle className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {title}
        </CardTitle>
        {action ? <span className="shrink-0">{action}</span> : null}
      </CardHeader>
      <CardContent className={cn("flex-1 px-4 py-4 sm:px-5", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )
}
