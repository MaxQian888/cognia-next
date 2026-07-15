"use client"

import { useCallback } from "react"

import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { browserClient } from "@/lib/browser/client"
import {
  type BrowserSelection,
  type ElementRect,
  formatSelectionComment,
  screenshotToFile,
} from "@/lib/browser/protocol"
import { buildSendContent, type SubmittedFile } from "@/lib/chat/attachments/dispatch"
import { useChatStore } from "@/stores/chat/chat-store"

export interface SendScreenshotOptions {
  /** Target chat session. Defaults to the focused session. */
  sessionId?: string
  /** Current preview URL, included in the prompt for context. */
  pageUrl?: string
}

export interface SendCommentOptions {
  /** Attach a screenshot of the embedded preview region. Defaults to true. */
  includeScreenshot?: boolean
  /** The embedded preview's reserved rect — required to capture a screenshot. */
  captureRect?: ElementRect
  /** Target chat session. Defaults to the focused session. */
  sessionId?: string
}

/**
 * Bridges a browser selection + comment into the existing chat send pipeline —
 * the chat core is untouched. Reuses {@link buildSendContent} for the
 * image+text content blocks and {@link useClaudeChat} for delivery.
 */
export function useSelectionToChat() {
  const { send, interruptAndSteer } = useClaudeChat()

  const sendComment = useCallback(
    async (
      selection: BrowserSelection,
      comment: string,
      options: SendCommentOptions = {}
    ): Promise<boolean> => {
      if (!comment.trim()) return false
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) throw new Error("No active chat session for the preview comment")

      const text = formatSelectionComment(selection, comment)
      const files: SubmittedFile[] = []
      if (options.includeScreenshot !== false && options.captureRect) {
        try {
          const shot = await browserClient.embedCapture(options.captureRect)
          if (shot?.bytes) files.push(screenshotToFile(shot.bytes))
        } catch {
          // Screenshot is best-effort — selector + outerHTML is enough context.
        }
      }
      const { content } = await buildSendContent(text, files)

      // A mid-stream `send` is enqueued text-only (the steer queue drops image
      // blocks), so interrupt first when the session is busy to keep the shot.
      const status = useChatStore.getState().sessions[sessionId]?.status
      if (status === "streaming" || status === "awaiting_approval") {
        await interruptAndSteer(sessionId)
      }
      await send(content, undefined, { sessionId })
      return true
    },
    [send, interruptAndSteer]
  )

  /**
   * Capture the preview region and ship it to chat as an image + a short
   * context line. Returns false when no chat session is available.
   */
  const sendScreenshot = useCallback(
    async (rect: ElementRect, options: SendScreenshotOptions = {}): Promise<boolean> => {
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return false

      const shot = await browserClient.embedCapture(rect)
      if (!shot?.bytes) throw new Error("Screenshot capture returned no image")
      const text = options.pageUrl
        ? `Screenshot of the in-app browser preview at ${options.pageUrl}.`
        : "Screenshot of the in-app browser preview."
      const { content } = await buildSendContent(text, [screenshotToFile(shot.bytes)])

      const status = useChatStore.getState().sessions[sessionId]?.status
      if (status === "streaming" || status === "awaiting_approval") {
        await interruptAndSteer(sessionId)
      }
      await send(content, undefined, { sessionId })
      return true
    },
    [send, interruptAndSteer]
  )

  /**
   * Ship a plain-text prompt to chat — the recorded-flow agent export. Returns
   * false when no chat session is available.
   *
   * Unlike {@link sendComment} this does NOT interrupt a live stream: the
   * interrupt exists only because the steer queue drops image blocks, and there
   * is no image here. Enqueuing text mid-turn is the intended path.
   */
  const sendText = useCallback(
    async (text: string, options: { sessionId?: string } = {}): Promise<boolean> => {
      if (!text.trim()) return false
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return false
      const { content } = await buildSendContent(text, [])
      await send(content, undefined, { sessionId })
      return true
    },
    [send]
  )

  return { sendComment, sendScreenshot, sendText }
}
