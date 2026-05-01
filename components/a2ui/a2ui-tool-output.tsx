"use client"

/**
 * A2UI Tool Output Renderer
 * Renders A2UI content from agent tool execution results
 */

import { useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"
import { parseA2UIInput } from "@/lib/a2ui/parser"
import { useA2UI } from "@/hooks/a2ui"
import { A2UISurface } from "./a2ui-surface"
import { useA2UIMessageIntegration } from "./a2ui-message-renderer"
import type { A2UIToolOutputProps, A2UIStructuredOutputProps } from "@/types/a2ui/renderer"

/**
 * Renders A2UI content from tool execution output
 */
export function A2UIToolOutput({
  toolId,
  toolName,
  output,
  className,
  onAction,
  onDataChange,
}: A2UIToolOutputProps) {
  const { processPayload, getSurface } = useA2UIMessageIntegration({ onAction, onDataChange })

  const surfaceId = useMemo(() => {
    const parsed = parseA2UIInput(output, { fallbackSurfaceId: `tool-${toolId}` })
    return parsed.messages.length > 0 ? parsed.surfaceId : null
  }, [output, toolId])

  useEffect(() => {
    if (surfaceId) {
      processPayload(output, `tool:${toolId}`, `tool-${toolId}`)
    }
  }, [output, processPayload, surfaceId, toolId])

  // Get the surface
  const surface = surfaceId ? getSurface(surfaceId) : null

  // If no A2UI content, return null
  if (!surfaceId || !surface) {
    return null
  }

  return (
    <div className={cn("a2ui-tool-output", className)}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{toolName}</span>
        <span>output</span>
      </div>
      <A2UISurface
        surfaceId={surfaceId}
        className="rounded-lg border bg-card"
        onAction={onAction}
        onDataChange={onDataChange}
      />
    </div>
  )
}

/**
 * Check if tool output contains A2UI content
 */
export function hasA2UIToolOutput(output: unknown): boolean {
  return parseA2UIInput(output).messages.length > 0
}

/**
 * Generic A2UI output wrapper for any structured data
 */
export function A2UIStructuredOutput({
  id,
  messages,
  title,
  className,
  onAction,
  onDataChange,
}: A2UIStructuredOutputProps) {
  const { processMessages, getSurface } = useA2UI({ onAction, onDataChange })

  // Get surface ID from messages
  const surfaceId = useMemo(() => {
    const firstMsg = messages.find((m) => "surfaceId" in m)
    return firstMsg ? (firstMsg as { surfaceId: string }).surfaceId : `output-${id}`
  }, [messages, id])

  // Process messages
  useEffect(() => {
    if (messages.length > 0) {
      processMessages(messages)
    }
  }, [messages, processMessages])

  const surface = getSurface(surfaceId)

  if (!surface) {
    return null
  }

  return (
    <div className={cn("a2ui-structured-output", className)}>
      {title && <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>}
      <A2UISurface surfaceId={surfaceId} onAction={onAction} onDataChange={onDataChange} />
    </div>
  )
}
