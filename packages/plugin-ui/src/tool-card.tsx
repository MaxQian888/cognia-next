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

/**
 * Theme-safe chrome for a plugin-rendered tool result.
 *
 * Tool results land in a chat column that is 375px wide on a phone, and their
 * content is whatever the tool returned — a long title, a row of actions, a
 * wide table or an unbroken path. None of that may push the card past the
 * column: the title truncates (`min-w-0` down the flex chain so it can shrink
 * below its text width), the header wraps the actions onto their own line
 * once they would squeeze the title under its 6rem basis (and the actions
 * wrap among themselves when even a full line is too narrow), and the body
 * scrolls sideways rather than overflowing.
 */
export function ToolCard({ title, badge, action, children, className, testId }: ToolCardProps) {
  return (
    <section
      data-slot="plugin-tool-card"
      data-testid={testId}
      className={cn("my-2 min-w-0 rounded-md border bg-card text-card-foreground", className)}
    >
      <header
        data-slot="plugin-tool-card-header"
        className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b bg-muted/40 px-3 py-2"
      >
        <span
          data-slot="plugin-tool-card-title"
          className="min-w-0 grow basis-24 truncate font-medium text-xs"
        >
          {title}
        </span>
        <div
          data-slot="plugin-tool-card-actions"
          className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1"
        >
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
      <div
        data-slot="plugin-tool-card-body"
        className="min-w-0 space-y-1 overflow-x-auto px-3 py-2 text-xs"
      >
        {children}
      </div>
    </section>
  )
}
