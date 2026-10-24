"use client"

/**
 * A2UIPart - Renders A2UI interactive surfaces within chat messages
 * Detects and processes A2UI content from AI responses
 *
 * Two duties beyond drawing the surface (ADR-0240):
 * - It binds the surface to the session its transcript row belongs to, so a
 *   button or form submit on it becomes that session's next user message
 *   (`lib/a2ui/chat-action-routing.ts`).
 * - When the payload yields no surface (invalid JSON, a rejected component),
 *   it shows the source with a notice instead of rendering nothing, so a
 *   failed interface never silently disappears from the reply.
 */

import React, { useEffect } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { A2UIInlineSurface, useA2UIMessageIntegration } from "@/components/a2ui"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { useA2UIChatBinding } from "./use-a2ui-chat-binding"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"
import type { A2UIUserAction, A2UIDataModelChange } from "@/types/a2ui/schema"

interface A2UIPartProps {
  part: A2UIPartType
  _messageId?: string
  /** Session whose transcript renders this part; defaults to the chat scope. */
  sessionId?: string
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

/** The fence body without its ``` lines, for the source fallback. */
export function a2uiFenceBody(content: string): string {
  const match = /^\s*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n?\s*\1\s*$/.exec(content)
  return (match ? match[2] : content).trim()
}

export function A2UIPart({
  part,
  _messageId,
  sessionId,
  className,
  onAction,
  onDataChange,
}: A2UIPartProps) {
  const t = useTranslations("chat.renderers.a2ui")
  const { processMessage, getSurface } = useA2UIMessageIntegration({ onAction, onDataChange })
  const [resolvedSurfaceId, setResolvedSurfaceId] = React.useState<string>(part.surfaceId)
  const [processed, setProcessed] = React.useState(false)

  // Process part content via unified A2UI integration.
  useEffect(() => {
    const enqueueStateUpdate = (updater: () => void) => {
      queueMicrotask(updater)
    }

    if (part.content) {
      const messageIdentity = _messageId ?? part.surfaceId
      let processedSurfaceId: string | null = null
      try {
        processedSurfaceId = processMessage(part.content, messageIdentity)
      } catch {
        // The store rejected the payload; the source fallback below covers it.
      }
      enqueueStateUpdate(() => {
        setResolvedSurfaceId(processedSurfaceId ?? part.surfaceId)
        setProcessed(true)
      })
      return
    }
    enqueueStateUpdate(() => {
      setResolvedSurfaceId(part.surfaceId)
      setProcessed(true)
    })
  }, [_messageId, part.content, part.surfaceId, processMessage])

  // Get the surface
  const surface = getSurface(resolvedSurfaceId)
  const hasSurface = Boolean(surface)

  useA2UIChatBinding(resolvedSurfaceId, { sessionId, messageId: _messageId, enabled: hasSurface })

  if (!surface) {
    // Nothing to show before the payload is processed, or for an empty part.
    if (!processed || !part.content?.trim()) return null
    return (
      <div className={cn("a2ui-part my-2 space-y-1", className)} data-a2ui-fallback>
        <p role="status" className="text-muted-foreground text-xs">
          {t("invalid")}
        </p>
        <div className="not-typeset">
          <CodeBlock code={a2uiFenceBody(part.content)} language="json" capHeight />
        </div>
      </div>
    )
  }

  return (
    <div className={cn("a2ui-part my-2", className)}>
      <A2UIInlineSurface
        surfaceId={resolvedSurfaceId}
        onAction={onAction}
        onDataChange={onDataChange}
      />
    </div>
  )
}

export default A2UIPart
