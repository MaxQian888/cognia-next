"use client"

import { useCallback } from "react"

import { useOptionalClaudeChat } from "@/hooks/chat/use-claude-chat"
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
import type { ElementSelectionCore } from "@/types/element-selection"
import { useChatStore } from "@/stores/chat/chat-store"
import {
  saveBrowserAnnotation,
  transitionBrowserAnnotation,
  type AnnotationTarget,
  type BrowserAnnotationIntent,
  type BrowserAnnotationRow,
  type BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/**
 * The media type a downloaded file is sent under when the backend did not say.
 * Only images need one: documents are routed by their filename extension.
 */
export function mediaTypeForFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? ""
  return IMAGE_MEDIA_TYPES[extension] ?? "application/octet-stream"
}

/** Chunked so a multi-megabyte download does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

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
 * image+text content blocks and the shared chat runtime for delivery.
 */
export function useSelectionToChat() {
  // Optional, not strict: the artifacts dock body constructs this hook and is
  // itself rendered in Storybook and in unit tests where no runtime is
  // mounted. Every entry point below refuses loudly rather than reporting a
  // send that never happened.
  const runtime = useOptionalClaudeChat()
  type Runtime = NonNullable<typeof runtime>
  const send = useCallback<Runtime["send"]>(
    (...args) => {
      if (!runtime) throw new Error("Cannot send: no ClaudeChatRuntimeProvider is mounted")
      return runtime.send(...args)
    },
    [runtime]
  )
  const interruptAndSteer = useCallback<Runtime["interruptAndSteer"]>(
    (...args) => {
      if (!runtime) throw new Error("Cannot steer: no ClaudeChatRuntimeProvider is mounted")
      return runtime.interruptAndSteer(...args)
    },
    [runtime]
  )

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

  /**
   * Persist one review annotation.
   *
   * Takes either a page (`baseUrl`) or an explicit `target`, because the queue
   * is shared with the artifact preview and an artifact element was never on a
   * page. Passing `baseUrl` keeps the browser's call sites — and the published
   * plugin surface — reading exactly as they did.
   */
  const queueAnnotation = useCallback(
    async (
      selection: BrowserSelection | ElementSelectionCore,
      comment: string,
      options: {
        sessionId?: string
        baseUrl?: string
        target?: AnnotationTarget
        intent?: BrowserAnnotationIntent
        severity?: BrowserAnnotationSeverity
      }
    ): Promise<BrowserAnnotationRow | undefined> => {
      if (!comment.trim()) return undefined
      const targetSessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!targetSessionId) return undefined
      const target: AnnotationTarget = options.target ?? {
        kind: "web",
        baseUrl: options.baseUrl ?? "",
      }
      const now = new Date().getTime()
      const annotation: BrowserAnnotationRow = {
        id: crypto.randomUUID(),
        sessionId: targetSessionId,
        // Only a web annotation carries one; absent is the honest answer for
        // anything else, and it keeps the `baseUrl` indexes meaning one thing.
        ...(target.kind === "web" ? { baseUrl: target.baseUrl } : {}),
        target,
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

  /**
   * Ship a file the browser downloaded to chat as an attachment (ADR-0201
   * Downloads panel "Attach to chat"). Goes through the same
   * {@link buildSendContent} gate as the composer, so a type the chat cannot
   * read is refused here instead of arriving as an empty turn.
   *
   * Resolves `"sent"`, `"no-session"`, or `"unsupported"` (every block was
   * rejected by the attachment pipeline).
   */
  const sendFileBytes = useCallback(
    async (
      bytes: Uint8Array,
      file: { filename: string; mimeType?: string; sourceUrl?: string },
      options: { sessionId?: string } = {}
    ): Promise<"sent" | "no-session" | "unsupported"> => {
      const sessionId = options.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return "no-session"
      const mediaType = file.mimeType || mediaTypeForFilename(file.filename)
      const submitted: SubmittedFile = {
        url: `data:${mediaType};base64,${bytesToBase64(bytes)}`,
        mediaType,
        filename: file.filename,
      }
      const text = file.sourceUrl
        ? `Attached ${file.filename}, downloaded in the in-app browser from ${file.sourceUrl}.`
        : `Attached ${file.filename}, downloaded in the in-app browser.`
      const { content, rejected } = await buildSendContent(text, [submitted])
      if (rejected.length > 0) return "unsupported"
      const status = useChatStore.getState().sessions[sessionId]?.status
      if (status === "streaming" || status === "awaiting_approval") {
        await interruptAndSteer(sessionId)
      }
      await send(content, undefined, { sessionId })
      return "sent"
    },
    [send, interruptAndSteer]
  )

  return {
    sendFileBytes,
    sendComment,
    queueAnnotation,
    sendAnnotations,
    sendScreenshot,
    sendScreenshotBytes,
    sendText,
  }
}
