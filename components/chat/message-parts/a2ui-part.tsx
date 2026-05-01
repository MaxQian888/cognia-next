"use client"

/**
 * A2UIPart - Renders A2UI interactive surfaces within chat messages
 * Detects and processes A2UI content from AI responses
 */

import React, { useEffect } from "react"
import { cn } from "@/lib/utils"
import { A2UIInlineSurface, useA2UIMessageIntegration } from "@/components/a2ui"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"
import type { A2UIUserAction, A2UIDataModelChange } from "@/types/a2ui/schema"

interface A2UIPartProps {
  part: A2UIPartType
  _messageId?: string
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

export function A2UIPart({ part, _messageId, className, onAction, onDataChange }: A2UIPartProps) {
  const { processMessage, getSurface } = useA2UIMessageIntegration({ onAction, onDataChange })
  const [resolvedSurfaceId, setResolvedSurfaceId] = React.useState<string>(part.surfaceId)

  // Process part content via unified A2UI integration.
  useEffect(() => {
    const enqueueStateUpdate = (updater: () => void) => {
      queueMicrotask(updater)
    }

    if (part.content) {
      const messageIdentity = _messageId ?? part.surfaceId
      const processedSurfaceId = processMessage(part.content, messageIdentity)
      enqueueStateUpdate(() => {
        setResolvedSurfaceId(processedSurfaceId ?? part.surfaceId)
      })
      return
    }
    enqueueStateUpdate(() => {
      setResolvedSurfaceId(part.surfaceId)
    })
  }, [_messageId, part.content, part.surfaceId, processMessage])

  // Get the surface
  const surface = getSurface(resolvedSurfaceId)

  // If no surface yet, return null (will render after processing)
  if (!surface) {
    return null
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
