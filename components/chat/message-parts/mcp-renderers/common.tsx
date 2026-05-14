"use client"

/**
 * Shared helpers for the structured MCP / built-in tool cards.
 *
 * Each tool returns its payload as a `ToolUIPart.output` value — sometimes
 * a string (MCP protocol returns text blocks), sometimes an object (Claude
 * SDK normalizes select tools). These helpers wrap the unstable parsing so
 * every card has the same fall-through behaviour: if the payload doesn't
 * parse, the card returns `null` and the renderer falls back to the
 * generic ToolBody.
 */

import { useMemo, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function parseOutputJson(output: unknown): unknown | null {
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
  if (typeof output === "object") return output
  return null
}

export function useParsedOutput<T>(output: unknown): T | null {
  return useMemo(() => parseOutputJson(output) as T | null, [output])
}

export function McpCardShell({
  title,
  badge,
  children,
  className,
  testId,
}: {
  title: string
  badge?: string
  children: ReactNode
  className?: string
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      className={cn("my-2 rounded-md border bg-card text-card-foreground", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="font-medium text-xs">{title}</span>
        {badge && (
          <Badge variant="outline" className="text-[10px]" data-testid={`${testId}-badge`}>
            {badge}
          </Badge>
        )}
      </div>
      <div className="space-y-1 px-3 py-2 text-xs">{children}</div>
    </div>
  )
}
