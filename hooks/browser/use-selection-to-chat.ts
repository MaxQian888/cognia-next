"use client"

import { useCallback } from "react"

import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { browserClient } from "@/lib/browser/client"
import { formatAnnotationBatch } from "@/lib/browser/annotation-queue"
import {
  type BrowserSelection,
  type ElementRect,
  type OutputDetailLevel,
  formatSelectionComment,
  formatSelectionsComment,
  screenshotToFile,
} from "@/lib/browser/protocol"
import { buildSendContent, type SubmittedFile } from "@/lib/chat/attachments/dispatch"
import { useChatStore } from "@/stores/chat/chat-store"
import {
  saveBrowserAnnotation,
  transitionBrowserAnnotation,
  type BrowserAnnotationIntent,
  type BrowserAnnotationRow,
  type BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"

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
  detailLevel?: OutputDetailLevel
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
      selection: BrowserSelection | BrowserSelection[],
      comment: string,
      options: SendCommentOptions = {}
    ): Promise<boolean> => {
      if (!comment.trim()) return false
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) throw new Error("No active chat session for the preview comment")

      const text = Array.isArray(selection)
        ? formatSelectionsComment(selection, comment, options.detailLevel)
        : formatSelectionComment(selection, comment, options.detailLevel)
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

  const sendAnnotations = useCallback(
    async (
      annotations: BrowserAnnotationRow[],
      options: SendCommentOptions = {}
    ): Promise<boolean> => {
      if (annotations.length === 0) return false
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return false

      const files: SubmittedFile[] = []
      // A batch gets one pane-level screenshot at send time. Annotation indexes
      // in the text are the stable reference; N screenshots would be noisy and
      // disproportionately expensive.
      if (options.includeScreenshot !== false && options.captureRect) {
        try {
          const shot = await browserClient.embedCapture(options.captureRect)
          if (shot?.bytes) files.push(screenshotToFile(shot.bytes))
        } catch {
          // Selection metadata remains sufficient when capture is unavailable.
        }
      }
      const { content } = await buildSendContent(
        formatAnnotationBatch(annotations, options.detailLevel),
        files
      )
      const status = useChatStore.getState().sessions[sessionId]?.status
      if (status === "streaming" || status === "awaiting_approval") {
        await interruptAndSteer(sessionId)
      }
      await send(content, undefined, { sessionId })
      const now = new Date().getTime()
      await Promise.all(
        annotations.map((annotation) =>
          transitionBrowserAnnotation(annotation.id, "acknowledged", now)
        )
      )
      return true
    },
    [send, interruptAndSteer]
  )

  const queueAnnotation = useCallback(
    async (
      selection: BrowserSelection,
      comment: string,
      options: {
        sessionId?: string
        baseUrl: string
        intent?: BrowserAnnotationIntent
        severity?: BrowserAnnotationSeverity
      }
    ): Promise<BrowserAnnotationRow | undefined> => {
      if (!comment.trim()) return undefined
      const targetSessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!targetSessionId) return undefined
      const now = new Date().getTime()
      const annotation: BrowserAnnotationRow = {
        id: crypto.randomUUID(),
        sessionId: targetSessionId,
        baseUrl: options.baseUrl,
        selection,
        comment: comment.trim(),
        intent: options.intent ?? "change",
        severity: options.severity ?? "suggestion",
        status: "pending",
        thread: [],
        createdAt: now,
        updatedAt: now,
      }
      await saveBrowserAnnotation(annotation)
      return annotation
    },
    []
  )

  /**
   * Ship a host-neutral browser engine's PNG bytes to chat. Embedded capture
   * and remote Chromium both converge here so streaming-session steering and
   * attachment construction cannot drift.
   */
  const sendScreenshotBytes = useCallback(
    async (bytes: string, options: SendScreenshotOptions = {}): Promise<boolean> => {
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return false
      if (!bytes) throw new Error("Screenshot capture returned no image")
      const text = options.pageUrl
        ? `Screenshot of the in-app browser preview at ${options.pageUrl}.`
        : "Screenshot of the in-app browser preview."
      const { content } = await buildSendContent(text, [screenshotToFile(bytes)])

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
   * Capture the embedded preview region and ship it through the shared image
   * delivery path. Returns false when no chat session is available.
   */
  const sendScreenshot = useCallback(
    async (rect: ElementRect, options: SendScreenshotOptions = {}): Promise<boolean> => {
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return false

      const shot = await browserClient.embedCapture(rect)
      if (!shot?.bytes) throw new Error("Screenshot capture returned no image")
      return sendScreenshotBytes(shot.bytes, { ...options, sessionId })
    },
    [sendScreenshotBytes]
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

  return {
    sendComment,
    queueAnnotation,
    sendAnnotations,
    sendScreenshot,
    sendScreenshotBytes,
    sendText,
  }
}
