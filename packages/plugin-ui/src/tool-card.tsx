"use client"

import { useMemo, type ReactNode } from "react"

import { Badge } from "./badge"
import { cn } from "./cn"

export function parseToolOutput(output: unknown): unknown | null {
  if (output === null || output === undefined) return null
  if (typeof output === "string") {
    const trimmed = output.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  return typeof output === "object" ? output : null
}

export function useParsedToolOutput<T>(output: unknown): T | null {
  return useMemo(() => parseToolOutput(output) as T | null, [output])
}

export interface ToolCardProps {
  title: string
  badge?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}

/** Theme-safe chrome for a plugin-rendered tool result. */
export function ToolCard({ title, badge, action, children, className, testId }: ToolCardProps) {
  return (
    <section
      data-slot="plugin-tool-card"
      data-testid={testId}
      className={cn("my-2 rounded-md border bg-card text-card-foreground", className)}
    >
      <header className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="font-medium text-xs">{title}</span>
        <div className="flex items-center gap-1">
          {badge ? (
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid={testId ? `${testId}-badge` : undefined}
            >
              {badge}
            </Badge>
          ) : null}
          {action}
        </div>
      </header>
      <div className="space-y-1 px-3 py-2 text-xs">{children}</div>
    </section>
  )
}
