"use client"

/**
 * A2UIBlock — wraps a markdown ```a2ui``` fence and routes it through the
 * standard A2UI message pipeline so the surface renders inline at the same
 * spot the model emitted the fence. Keeps the markdown surface free of
 * direct dependencies on the a2ui store/parser.
 */

import { useMemo } from "react"
import { A2UIPart } from "@/components/chat/message-parts/a2ui-part"
import type { A2UIPart as A2UIPartType } from "@/lib/claude/parts-extensions"

interface Props {
  /** Raw fence body (the JSON between the back-ticks). */
  content: string
  /** Optional message id for surface attribution. */
  messageId?: string
}

export function A2UIBlock({ content, messageId }: Props) {
  // Stable surfaceId per content + messageId combo so re-renders don't
  // create duplicate surfaces. The processor inside `useA2UIMessageIntegration`
  // overrides this with the surfaceId emitted by the JSON when present.
  const part = useMemo<A2UIPartType>(() => {
    const seed = (messageId ?? "a2ui") + "::" + simpleHash(content)
    return {
      type: "a2ui",
      surfaceId: seed,
      content,
      source: "codeblock",
    }
  }, [content, messageId])

  return <A2UIPart part={part} _messageId={messageId} />
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
