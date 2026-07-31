"use client"

/**
 * A2UI Message Renderer
 * Detects and renders A2UI content within chat messages
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useA2UI } from "@/hooks/a2ui"
import { detectA2UIContent, parseA2UIInput } from "@/lib/a2ui/parser"
import { A2UIInlineSurface } from "./a2ui-surface"
import type { A2UIUserAction, A2UIDataModelChange } from "@/types/a2ui/schema"
import type { A2UIMessageRendererProps } from "@/types/a2ui/renderer"

const PROCESSED_A2UI_CACHE_SIZE = 200
const processedA2UIMessageCache = new Map<string, string | null>()

function fingerprintContent(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${hash}`
}

function toCacheSeed(payload: unknown): string {
  if (typeof payload === "string") {
    return payload
  }
  try {
    return JSON.stringify(payload) ?? String(payload)
  } catch {
    return String(payload)
  }
}

function getCachedSurfaceId(key: string): string | null | undefined {
  if (!processedA2UIMessageCache.has(key)) {
    return undefined
  }

  const cachedValue = processedA2UIMessageCache.get(key)
  processedA2UIMessageCache.delete(key)
  processedA2UIMessageCache.set(key, cachedValue ?? null)
  return cachedValue
}

function setCachedSurfaceId(key: string, surfaceId: string | null): void {
  if (processedA2UIMessageCache.has(key)) {
    processedA2UIMessageCache.delete(key)
  }

  processedA2UIMessageCache.set(key, surfaceId)

  while (processedA2UIMessageCache.size > PROCESSED_A2UI_CACHE_SIZE) {
    const oldestKey = processedA2UIMessageCache.keys().next().value as string | undefined
    if (!oldestKey) {
      break
    }
    processedA2UIMessageCache.delete(oldestKey)
  }
}

/**
 * Renders A2UI content embedded in a chat message
 * Automatically detects and parses A2UI JSON from the message content
 * Also renders text content alongside A2UI when present
 */
export function A2UIMessageRenderer({
  content,
  messageId,
  className,
  textRenderer,
  onAction,
  onDataChange,
}: A2UIMessageRendererProps) {
  const { processMessage, getSurface } = useA2UIMessageIntegration({ onAction, onDataChange })
  const [processedSurfaceId, setProcessedSurfaceId] = useState<string | null>(null)

  // Detect if content has A2UI
  const hasA2UI = useMemo(() => detectA2UIContent(content), [content])

  // Extract non-A2UI text content
  const textContent = useMemo(() => {
    if (!hasA2UI) return content

    // Remove JSON code blocks that contain A2UI content
    let text = content
    const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g
    let match

    while ((match = jsonBlockRegex.exec(content)) !== null) {
      if (detectA2UIContent(match[1])) {
        text = text.replace(match[0], "")
      }
    }

    return text.trim()
  }, [content, hasA2UI])

  // Process A2UI content through the shared integration entry.
  useEffect(() => {
    const enqueueStateUpdate = (updater: () => void) => {
      queueMicrotask(updater)
    }

    if (!hasA2UI) {
      enqueueStateUpdate(() => setProcessedSurfaceId(null))
      return
    }

    enqueueStateUpdate(() => {
      setProcessedSurfaceId(processMessage(content, messageId))
    })
  }, [content, hasA2UI, messageId, processMessage])

  const surfaceId = processedSurfaceId ?? `msg-${messageId}`
  const surface = hasA2UI ? getSurface(surfaceId) : null

  // If no A2UI content and no text, return null
  if (!hasA2UI && !textContent) {
    return null
  }

  // If only text content (no A2UI), render text only
  if (!hasA2UI || !surface) {
    if (!textContent) return null
    return (
      <div className={cn("a2ui-message-content", className)}>
        <div className="message-text">{textRenderer ? textRenderer(textContent) : textContent}</div>
      </div>
    )
  }

  // Render both text and A2UI content
  return (
    <div className={cn("a2ui-message-content space-y-3", className)}>
      {textContent && (
        <div className="message-text">{textRenderer ? textRenderer(textContent) : textContent}</div>
      )}
      <A2UIInlineSurface surfaceId={surfaceId} onAction={onAction} onDataChange={onDataChange} />
    </div>
  )
}

/**
 * Check if a message contains A2UI content
 */
export function hasA2UIContent(content: string): boolean {
  return detectA2UIContent(content)
}

/**
 * Hook to integrate A2UI with chat messages
 */
export function useA2UIMessageIntegration(options?: {
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}) {
  const a2ui = useA2UI(options)
  const { processMessages, getSurface } = a2ui

  const processPayload = useCallback(
    (payload: unknown, identity: string, fallbackSurfaceId?: string): string | null => {
      const parsed = parseA2UIInput(payload, { fallbackSurfaceId })
      if (parsed.messages.length === 0) {
        return null
      }

      const payloadFingerprint = fingerprintContent(toCacheSeed(payload))
      const cacheKey = `${identity}:${payloadFingerprint}`
      const cachedSurfaceId = getCachedSurfaceId(cacheKey)
      if (cachedSurfaceId !== undefined) {
        return cachedSurfaceId
      }

      processMessages(parsed.messages)
      setCachedSurfaceId(cacheKey, parsed.surfaceId)
      return parsed.surfaceId
    },
    [processMessages]
  )

  const processMessage = useCallback(
    (content: string, messageId: string) => {
      if (!detectA2UIContent(content)) {
        return null
      }

      return (
        processPayload(content, `message:${messageId}`, `msg-${messageId}`) ?? `msg-${messageId}`
      )
    },
    [processPayload]
  )

  const renderA2UIContent = useCallback(
    (surfaceId: string) => {
      const surface = getSurface(surfaceId)
      if (!surface) return null

      return (
        <A2UIInlineSurface
          surfaceId={surfaceId}
          onAction={options?.onAction}
          onDataChange={options?.onDataChange}
        />
      )
    },
    [getSurface, options?.onAction, options?.onDataChange]
  )

  const hasA2UIContentInPayload = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      return detectA2UIContent(payload)
    }
    // Cheap marker scan over the serialized payload instead of a full
    // parseA2UIInput run just to answer a boolean
    if (payload === null || typeof payload !== "object") {
      return false
    }
    try {
      const serialized = JSON.stringify(payload)
      return serialized ? detectA2UIContent(serialized) : false
    } catch {
      return false
    }
  }, [])

  return {
    ...a2ui,
    processPayload,
    processMessage,
    renderA2UIContent,
    hasA2UIContent: hasA2UIContentInPayload,
  }
}
