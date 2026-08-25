"use client"

/**
 * Remote Session Control — the composer on the mobile session detail view.
 *
 * Split out of `remote-session-detail.tsx` when attachments arrived: the detail
 * view is a transcript with three tabs, and the composer is now a small state
 * machine of its own (staged files, per-file upload progress, a send that must
 * not clear anything until the Host has durably accepted it).
 *
 * The attachment path deliberately borrows the desktop's decisions rather than
 * making its own:
 *
 *  - **which files may be staged** is `prepareComposerAttachments`, the same
 *    gate the paperclip on the desktop runs — including its oversized-image
 *    rescue, so a 12 MB photo is downscaled instead of refused.
 *  - **how many, and how large** come from the Host feature manifest, which
 *    publishes the same constants the desktop composer enforces. A phone that
 *    guessed would stage six files and be refused one upload at a time.
 *  - **whether the paperclip exists at all** is `session.attachment-upload` in
 *    that manifest. An older Host has nowhere to put the bytes, and a picker
 *    that stages a file the Host will drop is worse than no picker.
 *
 * Sending clears the composer only after `onSend` resolves. A failed upload, a
 * lost control lease, or a rejected `message.enqueue` therefore leaves the text
 * AND the files exactly where they were — the one thing a user cannot recover
 * from is a composer that emptied itself for a message that never arrived.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { PaperclipIcon, SendIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"
import type { FileUIPart } from "ai"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Attachment,
  AttachmentInfo,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import {
  clearDraft,
  getDraft,
  setDraftDebounced,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { readStoredBytes } from "@/lib/db/stored-bytes"
import { sha256Bytes } from "@/lib/ocr/hash"
import {
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  prepareComposerAttachments,
} from "@/lib/chat/attachments/prepare"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  abortSessionAttachmentUpload,
  type UploadableAttachment,
} from "@/lib/companion/attachment-upload-client"
import type { RemoteSendOptions } from "@/hooks/data/use-remote-session-stream"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { listParamTokens } from "@/lib/chat/template/param-segments"

interface StagedFile {
  id: string
  name: string
  mediaType: string
  size: number
  /**
   * Read once, at staging time.
   *
   * A `File` handle would be cheaper to hold but cannot survive the draft, and
   * on iOS a picked file's handle can go stale while the app is backgrounded —
   * which is exactly the window a resumable upload exists to cover.
   */
  bytes: Uint8Array
  /** Computed at staging time so a resume never re-hashes the whole file. */
  hash?: string
  /** The Host-side upload this file is going through, once one has opened. */
  uploadId?: string
  /** Bytes the Host has confirmed. */
  uploadedBytes: number
}

export interface RemoteSessionComposerProps {
  sessionId: string
  /** True while the host turn is producing — swaps send for interrupt. */
  streaming: boolean
  /** Transport is down or reconnecting; sends cannot reach the desktop. */
  offline: boolean
  onSend: (
    text: string,
    attachments: readonly UploadableAttachment[],
    options?: RemoteSendOptions
  ) => Promise<void>
  onInterrupt: () => void
}

export function RemoteSessionComposer({
  sessionId,
  streaming,
  offline,
  onSend,
  onInterrupt,
}: RemoteSessionComposerProps) {
  const t = useTranslations("mobile.remoteSessions.detail")
  const [draft, setDraft] = useState("")
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [sending, setSending] = useState(false)
  const [restoredFor, setRestoredFor] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Shell-style ↑/↓ recall of previously sent follow-ups, persisted per remote
  // session so the steer history survives a reload of the mobile shell.
  const history = useCommandHistory({ persistKey: `cmdhist:remote-session:${sessionId}` })

  /**
   * What this Host will take, or null when it cannot take attachments at all.
   *
   * Read from the negotiated runtime snapshot — the same place
   * `enqueueHostStateIntentIfAvailable` reads to decide whether the send path
   * exists — and NOT from `stores/remote-host`. That store is the desktop's
   * own registry of remote hosts; it is empty in the companion shell, which is
   * the only shell this view runs in, so gating on it hid the paperclip
   * everywhere it could ever have been useful.
   *
   * Gated on the operation rather than the feature id, because the operation
   * list is what the Host actually reports as healthy.
   */
  const runtime = useRuntimeSnapshot()
  const uploads = useMemo(() => {
    const host = runtime.host
    if (!host?.compatible) return null
    if (!host.operations.includes("session_attachment_upload_init")) return null
    const limits = host.limits
    return {
      accept: (limits?.attachmentAcceptTypes ?? ["image/*"]).join(","),
      maxFiles: limits?.attachmentMaxPerMessage ?? COMPOSER_MAX_ATTACHMENTS,
      maxBytes: limits?.attachmentMaxBytes ?? COMPOSER_MAX_ATTACHMENT_BYTES,
    }
  }, [runtime])

  // Restore what was staged last time. A phone loses its process constantly —
  // a call, a background eviction, a reload — and a composer that came back
  // empty meant re-picking every file and re-uploading every byte. `hash` and
  // `uploadId` come back with them, so a restored file rejoins its upload at
  // the Host's write head instead of starting over.
  useEffect(() => {
    let cancelled = false
    void getDraft(sessionId)
      .then((row) => {
        if (cancelled || !row) return
        setDraft(row.text)
        setStaged(
          (row.attachments ?? [])
            .map((attachment) => ({
              attachment,
              // A row whose binary was evicted by the draft quota, or which
              // rehydrated as something other than a typed array, has nothing
              // to upload — it degrades to the reminder-chip behaviour drafts
              // have always had rather than staging an empty file.
              bytes: readStoredBytes(attachment.bytes),
            }))
            .filter((entry): entry is { attachment: DraftAttachmentMeta; bytes: Uint8Array } =>
              entry.bytes !== undefined
            )
            .map(({ attachment, bytes }) => ({
              id: crypto.randomUUID(),
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: bytes.byteLength,
              bytes,
              hash: attachment.hash,
              uploadId: attachment.uploadId,
              uploadedBytes: attachment.uploadedBytes ?? 0,
            }))
        )
      })
      .catch(() => undefined)
      .finally(() => {
        // Set from the async continuation, not the effect body: `restoredFor`
        // still naming the PREVIOUS session is exactly the gate the persist
        // effect below needs while a switch is in flight.
        if (!cancelled) setRestoredFor(sessionId)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Persist only AFTER the restore has settled. Writing before it would save
  // the empty initial state over the draft we are in the middle of reading.
  useEffect(() => {
    if (restoredFor !== sessionId) return
    setDraftDebounced(
      sessionId,
      draft,
      staged.map((entry) => ({
        name: entry.name,
        mediaType: entry.mediaType,
        size: entry.size,
        bytes: entry.bytes,
        ...(entry.hash ? { hash: entry.hash } : {}),
        ...(entry.uploadId ? { uploadId: entry.uploadId } : {}),
        uploadedBytes: entry.uploadedBytes,
      }))
    )
  }, [draft, restoredFor, sessionId, staged])

  const acceptFiles = useCallback(
    async (incoming: FileList | null) => {
      if (!incoming || incoming.length === 0 || !uploads) return
      const prepared = await prepareComposerAttachments(Array.from(incoming), {
        maxFileSize: uploads.maxBytes,
      })
      if (prepared.unsupportedCount > 0) toast.warning(t("attachmentUnsupported"))
      if (prepared.tooLargeCount > 0) {
        toast.warning(
          t("attachmentTooLarge", { max: Math.round(uploads.maxBytes / (1024 * 1024)) })
        )
      }
      if (prepared.files.length === 0) return
      // Read the bytes and hash them here, once. The hash is the Host's dedupe
      // key, so paying for it at staging time is what lets a retry — or a
      // restart — cost one round trip instead of the whole file.
      const entries: StagedFile[] = await Promise.all(
        prepared.files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer())
          return {
            id: crypto.randomUUID(),
            name: file.name,
            mediaType: file.type,
            size: bytes.byteLength,
            bytes,
            hash: await sha256Bytes(bytes),
            uploadedBytes: 0,
          }
        })
      )
      setStaged((current) => {
        // Headroom is read off the CURRENT list inside the updater, not from a
        // value captured when the picker opened: two quick picks would each see
        // the same stale count and together exceed the ceiling.
        const headroom = Math.max(0, uploads.maxFiles - current.length)
        if (entries.length > headroom) {
          toast.warning(t("attachmentTooMany", { max: uploads.maxFiles }))
        }
        return [...current, ...entries.slice(0, headroom)]
      })
    },
    [t, uploads]
  )

  const removeStaged = useCallback((id: string) => {
    setStaged((current) => {
      // Tell the Host too. The staging slot is bounded per (session, device),
      // so a file the user removed would otherwise hold one of six places
      // until its 30-minute TTL, and its bytes would sit on the desktop's disk
      // for the same period with nothing left that could reference them.
      const removed = current.find((entry) => entry.id === id)
      if (removed?.uploadId) void abortSessionAttachmentUpload(removed.uploadId)
      return current.filter((entry) => entry.id !== id)
    })
  }, [])

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (sending) return
    if (!text && staged.length === 0) return
    // `{{parameter}}` tokens arrive here whenever a desktop draft syncs across:
    // `draft.replace` carries the TEXT, but not the values bound to it, so a
    // half-filled template reaches this device with its holes and nothing to
    // fill them from. Refuse rather than ship a literal `{{module}}` to the
    // model, which will act as though it understood.
    //
    // Deliberately reads the tokens out of the text rather than out of a
    // binding: that is what makes the refusal hold on a device the binding
    // never reached, which is the only case that matters here. Filling them is
    // desktop-only for now, so the message says where to go.
    const unfilled = listParamTokens(text, computeCodeRanges(text))
    if (unfilled.length > 0) {
      toast.error(t("templateParamsUnfilled", { count: unfilled.length }))
      return
    }
    const files = staged
    setSending(true)
    try {
      const uploadables: UploadableAttachment[] = files.map((entry) => ({
        name: entry.name,
        mediaType: entry.mediaType,
        bytes: entry.bytes,
        ...(entry.hash ? { hash: entry.hash } : {}),
      }))
      await onSend(text, uploadables, {
        onUploadProgress: (index, progress) => {
          const target = files[index]
          if (!target) return
          setStaged((current) =>
            current.map((entry) =>
              entry.id === target.id
                ? {
                    ...entry,
                    uploadedBytes: progress.uploadedBytes,
                    uploadId: progress.uploadId,
                  }
                : entry
            )
          )
        },
      })
      // Only now. Everything above can fail, and the composer is the only place
      // the text and the files still exist. The draft goes with them: the Host
      // has the message, so keeping a copy of the bytes here is only a way to
      // send them twice.
      if (text) history.record(text)
      setDraft("")
      setStaged([])
      void clearDraft(sessionId).catch(() => undefined)
    } catch {
      // `onSend` already told the user what went wrong; keeping the staged
      // state IS the recovery, and a second toast here would just repeat it.
      setStaged((current) => current.map((entry) => ({ ...entry, uploadedBytes: 0 })))
    } finally {
      setSending(false)
    }
  }, [draft, history, onSend, sending, sessionId, staged, t])

  const blocked = offline || sending

  return (
    <div className="border-t p-2">
      {offline ? (
        <p className="px-1 pb-1 text-[11px] text-muted-foreground" data-testid="remote-offline-hint">
          {t("offlineHint")}
        </p>
      ) : null}
      {staged.length > 0 ? (
        <Attachments variant="inline" className="px-1 pb-2" data-testid="remote-staged-attachments">
          {staged.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-1">
              <Attachment
                data={stagedAsAttachmentData(entry)}
                onRemove={sending ? undefined : () => removeStaged(entry.id)}
                data-testid="remote-attachment-chip"
              >
                <AttachmentInfo />
                {sending ? null : (
                  <AttachmentRemove
                    aria-label={t("attachmentRemoveAria")}
                    data-testid="remote-attachment-remove"
                  />
                )}
              </Attachment>
              {sending ? (
                <Progress
                  value={progressPercent(entry)}
                  aria-label={t("attachmentUploading", { name: entry.name })}
                  data-testid="remote-attachment-progress"
                  className="h-1"
                />
              ) : null}
            </div>
          ))}
        </Attachments>
      ) : null}
      <div className="flex items-center gap-2">
        {uploads ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={uploads.accept}
              className="hidden"
              data-testid="remote-attach-input"
              onChange={(event) => {
                void acceptFiles(event.target.files)
                // Clear so picking the same file twice in a row still fires.
                event.target.value = ""
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              disabled={blocked}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t("attachAria")}
              data-testid="remote-attach"
            >
              <PaperclipIcon className="h-4 w-4" />
            </Button>
          </>
        ) : null}
        <Input
          value={draft}
          disabled={sending}
          onChange={(e) => {
            setDraft(e.target.value)
            history.noteEdit()
          }}
          onKeyDown={(e) => {
            if (handleHistoryArrowKey(e, history, setDraft)) return
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!blocked) void submit()
            }
          }}
          placeholder={t("composerPlaceholder")}
          aria-label={t("composerAria")}
          data-testid="remote-composer-input"
        />
        {streaming ? (
          <Button
            size="icon"
            variant="outline"
            onClick={onInterrupt}
            aria-label={t("interruptAria")}
            data-testid="remote-interrupt"
          >
            <SquareIcon className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            disabled={blocked}
            onClick={() => void submit()}
            aria-label={t("sendAria")}
            data-testid="remote-send"
          >
            <SendIcon className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** The vendored chip primitives read a `FileUIPart`; project one from the record. */
function stagedAsAttachmentData(entry: StagedFile): FileUIPart & { id: string } {
  return {
    id: entry.id,
    type: "file",
    url: "",
    mediaType: entry.mediaType,
    filename: entry.name,
  }
}

function progressPercent(entry: StagedFile): number {
  if (entry.size <= 0) return 0
  return Math.min(100, Math.round((entry.uploadedBytes / entry.size) * 100))
}
