"use client"

/**
 * Everything that gets bytes and folded text INTO the composer.
 *
 * Extracted verbatim from `components/chat/composer.tsx`, where these handlers
 * were spread across ~250 lines of a 3k-line component. They form one concern:
 * a file arrives (paperclip, mobile "+", paste, drop, smart snapshot, or a
 * remote doc pick) and has to pass the same size / count / type gate before it
 * becomes a staged attachment. Keeping them together is what makes that gate
 * provably single-source — `acceptFiles` is the only path to `attachments.add`.
 *
 * Oversized TEXT pastes ride along here too: they are an intake path as well,
 * just one that folds into a `[Pasted N lines #id]` placeholder instead of an
 * attachment. The pure fold/expand logic lives in `@/lib/paste-collapse` and is
 * shared with the CLI TUI input; only the React state for the folded bodies is
 * held here.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, DragEvent } from "react"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import {
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  prepareComposerAttachments,
} from "@/lib/chat/attachments/prepare"
import { captureSmartSnapshotFiles, SMART_SNAPSHOT_COMMAND_ID } from "@/lib/chat/smart-snapshot"
import { collectDroppedFiles, MAX_DROPPED_DIR_FILES } from "@/lib/chat/drop-entries"
import { registerCommand } from "@/lib/plugin/commands/registry"
import { collapsePaste } from "@/lib/paste-collapse"
import { spliceToken } from "@/components/chat/composer-trigger"
import { useRemoteDocStaging, type RemoteDocStagingItem } from "@/hooks/chat/use-remote-doc-staging"
import { showMainWindow } from "@/lib/tauri/pet-window"
import {
  attachmentToFiles,
  type ComposerAttachment,
} from "@/components/mobile/chat/composer-plus-menu"

/** Shared with the Host attachment-upload manifest so a remote client is held
 *  to the same ceiling as the desktop paperclip. */
const MAX_FILES = COMPOSER_MAX_ATTACHMENTS
const MAX_FILE_SIZE = COMPOSER_MAX_ATTACHMENT_BYTES

/** The slice of `usePromptInputAttachments()` this hook needs. */
interface AttachmentsApi {
  files: readonly unknown[]
  add: (files: File[]) => void
}

/** The slice of `usePromptInputController()` this hook needs. */
interface TextInputApi {
  value: string
  setInput: (next: string) => void
}

export interface UseAttachmentIntakeOptions {
  attachments: AttachmentsApi
  textInput: TextInputApi
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** Moves the composer's caret model after a splice. */
  setCaret: (caret: number) => void
  isDesktop: boolean
  /** `useTranslations("chat.composer")` — smart-snapshot copy. */
  t: (key: string, values?: Record<string, string | number | Date>) => string
  /** `useTranslations("chat.composer.attachments")` — gate copy. */
  tAttach: (key: string, values?: Record<string, string | number | Date>) => string
}

export function useAttachmentIntake({
  attachments,
  textInput,
  textareaRef,
  setCaret,
  isDesktop,
  t,
  tAttach,
}: UseAttachmentIntakeOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentPrepareCountRef = useRef(0)
  const [attachmentPrepareCount, setAttachmentPrepareCount] = useState(0)
  const isPreparingAttachments = attachmentPrepareCount > 0
  // Tracked separately from the batch count above because only images get a
  // placeholder chip: their decode/downscale is the slow path, and the chip's
  // scan animation would misdescribe a document.
  const [preparingImageCount, setPreparingImageCount] = useState(0)
  const attachmentFileCountRef = useRef(attachments.files.length)
  useEffect(() => {
    attachmentFileCountRef.current = attachments.files.length
  }, [attachments.files])

  const [dragDepth, setDragDepth] = useState(0)
  // Oversized text pastes are folded into a `[Pasted N lines #id]` placeholder
  // (mirrors the CLI's paste-collapse): the full body is held aside, keyed by
  // its placeholder, and re-expanded at send time. Removable chips above the
  // textarea show what was folded. `pasteSeq` keeps ids stable + unique.
  const [pastedBlocks, setPastedBlocks] = useState<Record<string, string>>({})
  const pasteSeq = useRef(0)

  const acceptFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files]
      const imageCount = list.filter((f) => (f.type ?? "").startsWith("image/")).length
      attachmentPrepareCountRef.current += 1
      setAttachmentPrepareCount((count) => count + 1)
      if (imageCount > 0) setPreparingImageCount((count) => count + imageCount)
      try {
        const prepared = await prepareComposerAttachments(list, {
          maxFileSize: MAX_FILE_SIZE,
        })
        if (prepared.unsupportedCount > 0) {
          toast.warning(tAttach("unsupported", { count: prepared.unsupportedCount }))
        }
        if (prepared.tooLargeCount > 0) {
          toast.warning(
            tAttach("fileSizeExceeded", {
              count: prepared.tooLargeCount,
              max: MAX_FILE_SIZE / (1024 * 1024),
            })
          )
        }
        if (prepared.optimizedCount > 0) {
          toast.success(tAttach("optimized", { count: prepared.optimizedCount }))
        }
        // Preparation is async for oversized images. Track the latest staged
        // list in a ref so two concurrent pick/drop operations cannot both see
        // stale headroom and exceed MAX_FILES.
        const headroom = Math.max(0, MAX_FILES - attachmentFileCountRef.current)
        const take = prepared.files.slice(0, headroom)
        if (prepared.files.length > headroom) {
          toast.warning(tAttach("countLimit", { max: MAX_FILES }))
        }
        if (take.length > 0) {
          attachmentFileCountRef.current += take.length
          attachments.add(take)
        }
      } finally {
        attachmentPrepareCountRef.current = Math.max(0, attachmentPrepareCountRef.current - 1)
        setAttachmentPrepareCount((count) => Math.max(0, count - 1))
        if (imageCount > 0) setPreparingImageCount((count) => Math.max(0, count - imageCount))
      }
    },
    [attachments, tAttach]
  )

  const [smartSnapshotPending, setSmartSnapshotPending] = useState(false)
  const captureSmartSnapshot = useCallback(
    async (options: { delayMs?: number; switchPrompt?: boolean } = {}) => {
      if (!isDesktop || smartSnapshotPending) return
      setSmartSnapshotPending(true)
      try {
        if (options.switchPrompt) {
          toast.message(t("smartSnapshot.switchPrompt"))
        }
        const delayMs = Math.max(0, options.delayMs ?? 0)
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        const result = await captureSmartSnapshotFiles()
        attachments.add(result.files)
        toast.success(t("smartSnapshot.captured", { appName: result.appName }))
        // A global shortcut runs while another application is focused. Capture
        // first, then raise Cognia so the staged attachments are visible.
        void showMainWindow()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("smartSnapshot.captureFailed"))
      } finally {
        setSmartSnapshotPending(false)
      }
    },
    [attachments, isDesktop, smartSnapshotPending, t]
  )

  useEffect(() => {
    if (!isDesktop) return
    return registerCommand({
      id: SMART_SNAPSHOT_COMMAND_ID,
      title: t("smartSnapshot.captureTooltip"),
      category: "Chat",
      pluginId: null,
      handler: () => captureSmartSnapshot(),
    })
  }, [captureSmartSnapshot, isDesktop, t])

  const stageRemoteDoc = useRemoteDocStaging({
    acceptFiles: (files) => void acceptFiles(files),
  })

  // Mobile "+" menu → fold every pick (camera / album multi-pick / files)
  // into the same acceptFiles gate the paperclip input uses, so the size /
  // count / type limits and their toasts stay single-source.
  const onPlusAttach = useCallback(
    (attachment: ComposerAttachment) => {
      void attachmentToFiles(attachment)
        .then((files) => {
          if (files.length > 0) void acceptFiles(files)
        })
        .catch((err: unknown) => {
          loggers.chat.warn("plus-menu attach failed", {
            err: err instanceof Error ? err.message : String(err),
          })
          toast.error(err instanceof Error ? err.message : String(err))
        })
    },
    [acceptFiles]
  )

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        acceptFiles(files)
        return
      }
      // Fold an oversized text paste into a `[Pasted N lines #id]` placeholder
      // rather than flooding the textarea. Small pastes fall through to the
      // browser's native insert. The full body is held in `pastedBlocks` and
      // re-expanded on send.
      const text = e.clipboardData?.getData("text") ?? ""
      if (!text) return
      const folded = collapsePaste(text, pasteSeq.current)
      if (!folded.isLarge) return
      e.preventDefault()
      pasteSeq.current += 1
      const ta = textareaRef.current
      const cur = textInput.value
      const start = ta?.selectionStart ?? cur.length
      const end = ta?.selectionEnd ?? cur.length
      const result = spliceToken(cur, start, end, folded.display)
      textInput.setInput(result.value)
      setCaret(result.caret)
      setPastedBlocks((prev) => ({ ...prev, [folded.display]: folded.stored }))
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(result.caret, result.caret)
          ta2.focus()
        }
      })
    },
    [acceptFiles, textInput, setCaret, textareaRef]
  )

  // Drop a folded paste: remove its placeholder from the text and forget the
  // stored body (chip "×" or editing the placeholder out by hand).
  const removePastedBlock = useCallback(
    (placeholder: string) => {
      setPastedBlocks((prev) => {
        if (!(placeholder in prev)) return prev
        const next = { ...prev }
        delete next[placeholder]
        return next
      })
      const cur = textInput.value
      if (cur.includes(placeholder)) {
        textInput.setInput(cur.split(placeholder).join(""))
      }
    },
    [textInput]
  )

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return
    setDragDepth((d) => d + 1)
  }, [])
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault()
  }, [])
  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Symmetric with onDragEnter: only file drags incremented the depth, so
    // only file drags may decrement it. An interleaved non-file dragleave would
    // otherwise prematurely drop the counter and flicker the overlay off.
    if (!e.dataTransfer?.types?.includes("Files")) return
    setDragDepth((d) => Math.max(0, d - 1))
  }, [])
  // Drops are resolved generically: plain files and whole directories arrive
  // through the same handler, and a dropped folder is flattened into its files
  // rather than staging one junk zero-byte attachment. (A dropped directory
  // carries no absolute path, so it cannot take the reference path the attach
  // menu's native folder picker uses — see lib/chat/drop-entries.ts.)
  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      setDragDepth(0)
      const dataTransfer = e.dataTransfer
      const hasPayload =
        (dataTransfer?.files?.length ?? 0) > 0 || (dataTransfer?.items?.length ?? 0) > 0
      if (!dataTransfer || !hasPayload) return
      e.preventDefault()
      void collectDroppedFiles(dataTransfer)
        .then((dropped) => {
          if (dropped.truncated) {
            toast.warning(tAttach("folderTruncated", { max: MAX_DROPPED_DIR_FILES }))
          }
          if (dropped.files.length > 0) return acceptFiles(dropped.files)
          if (dropped.directories > 0) toast.warning(tAttach("folderEmpty"))
        })
        .catch((err: unknown) => {
          loggers.chat.warn("drop resolution failed", {
            err: err instanceof Error ? err.message : String(err),
          })
        })
    },
    [acceptFiles, tAttach]
  )

  const onFilePick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) void acceptFiles(e.target.files)
      e.target.value = ""
    },
    [acceptFiles]
  )

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  return {
    fileInputRef,
    acceptFiles,
    /** Synchronous in-flight count. The send guard must read the LATEST value
     *  (not the render-time state) so a fast Enter during preparation is
     *  rejected rather than sending an incomplete turn. */
    attachmentPrepareCountRef,
    /** Raw setter: the send path clears the folded bodies optimistically and
     *  restores the saved map if the send fails, and draft restore drops them. */
    setPastedBlocks,
    onPlusAttach,
    onPaste,
    onFilePick,
    openFileDialog,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    isDragging: dragDepth > 0,
    pastedBlocks,
    removePastedBlock,
    attachmentPrepareCount,
    isPreparingAttachments,
    preparingImageCount,
    captureSmartSnapshot,
    smartSnapshotPending,
    stageRemoteDoc,
  }
}

export type { RemoteDocStagingItem }
