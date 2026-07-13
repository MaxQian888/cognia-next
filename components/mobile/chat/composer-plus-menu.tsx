"use client"

/**
 * Mobile chat composer Plus menu (Wave 2.6).
 *
 * Surfaces the four attachment paths used in mobile chat:
 *
 *   - Camera   → `lib/capacitor/camera.ts:pickPhoto({ source: "camera" })`
 *   - Album    → `lib/capacitor/camera.ts:pickMultiplePhotos`
 *   - File     → web file input (Capacitor filesystem v7 lacks a unified
 *                picker; `<input type="file">` works on both Capacitor and
 *                browsers)
 *   - Voice    → `capacitor-voice-recorder` (loaded lazily so the web
 *                bundle skips the native module)
 *
 * The menu is purely an action launcher — the chosen attachment is
 * forwarded to `onAttach(payload)` so the chat-room component can persist
 * + enqueue an outbound `connector_send` job as appropriate.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CameraIcon, FileIcon, ImageIcon, MicIcon, PaperclipIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { pickMultiplePhotos, pickPhoto } from "@/lib/capacitor/camera"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { showToast } from "@/lib/capacitor/toast"
import { makeDefaultLoader, withPlugin } from "@/lib/capacitor/_shared"
import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export type ComposerAttachment =
  | { kind: "photo"; base64?: string; uri?: string; mime: string }
  | { kind: "photos"; items: Array<{ uri: string; mime: string }> }
  | { kind: "file"; file: File }
  | { kind: "files"; files: File[] }
  | { kind: "voice"; recordingDataUrl: string; mimeType: string; durationMs?: number }

export interface ComposerPlusMenuProps {
  /**
   * Receives the result of whichever option the user picked. Should NOT
   * persist the message — it's the caller's job to fold the attachment
   * into a draft + outbound queue write.
   */
  onAttach: (attachment: ComposerAttachment) => void
  /**
   * Optional. When provided, the camera/album/file branches additionally
   * pack their result as a {@link SendContent} block array and forward it
   * to this callback so the chat composer can ship the attachment through
   * the normal send pipeline (`claude_send` → SDK image block).
   *
   * Image picks become `{ type: "image", source: { type: "base64", data,
   * media_type } }` blocks; non-image files fall back through `onAttach`
   * since the SDK's send shape doesn't carry generic file blocks (yet).
   * Voice is intentionally left to `onAttach` only — outbound queue is
   * the right path for voice payloads.
   */
  onSend?: (content: SendContent) => Promise<void> | void
  /** Triggered with the raw error code on failure paths (permission, etc.). */
  onError?: (code: string, message: string) => void
  /**
   * Hide the voice-recording branch. The main chat composer sets this to
   * false because voice input there is the transcription bridge (speech →
   * text) — an audio *attachment* has no send path to the model. Connector
   * chat surfaces keep the default (true) since `connector_send` can carry
   * media payloads.
   */
  showVoice?: boolean
  /** `accept` for the file-branch input; defaults to any file. */
  fileAccept?: string
  className?: string
}

interface VoiceRecorderShape {
  requestAudioRecordingPermission(): Promise<{ value: boolean }>
  hasAudioRecordingPermission(): Promise<{ value: boolean }>
  startRecording(): Promise<{ value: boolean }>
  stopRecording(): Promise<{
    value: { recordDataBase64: string; mimeType: string; msDuration: number }
  }>
}

const voiceLoader = makeDefaultLoader<VoiceRecorderShape>(
  "capacitor-voice-recorder",
  "VoiceRecorder"
)

export function ComposerPlusMenu({
  onAttach,
  onSend,
  onError,
  showVoice = true,
  fileAccept,
  className,
}: ComposerPlusMenuProps) {
  const t = useTranslations("mobile.composerPlus")
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(false)

  const onCamera = async () => {
    setOpen(false)
    void selectionFeedback()
    const result = await pickPhoto({ source: "camera", resultType: "base64" })
    if (result.kind === "captured") {
      const mime = `image/${result.format}`
      onAttach({
        kind: "photo",
        base64: result.base64,
        uri: result.uri,
        mime,
      })
      if (onSend && result.base64) {
        await onSend(packPhotoAsSendContent(result.base64, mime))
      }
      return
    }
    if (result.kind === "permission_denied") {
      onError?.("permission", t("permissionDeniedCamera"))
      void showToast({ text: t("permissionDeniedCamera") })
      return
    }
    if (result.kind === "cancelled") return
    if (result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    onError?.("error", result.message)
  }

  const onAlbum = async () => {
    setOpen(false)
    void selectionFeedback()
    const result = await pickMultiplePhotos({ limit: 9 })
    if (result.kind === "picked") {
      const items = result.photos.map((p) => ({ uri: p.uri, mime: `image/${p.format}` }))
      onAttach({ kind: "photos", items })
      if (onSend) {
        try {
          const blocks = await Promise.all(items.map(packUriAsImageBlock))
          await onSend(blocks.filter((b): b is SendContentBlock => b !== null))
        } catch (err) {
          onError?.("error", err instanceof Error ? err.message : String(err))
        }
      }
      return
    }
    if (result.kind === "cancelled") return
    if (result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    onError?.("error", result.message)
  }

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length === 0) return
    onAttach({ kind: "files", files })
    if (onSend) {
      const images = files.filter((f) => f.type.startsWith("image/"))
      if (images.length > 0) {
        try {
          const blocks = await Promise.all(images.map(packFileAsImageBlock))
          const valid = blocks.filter((b): b is SendContentBlock => b !== null)
          if (valid.length > 0) await onSend(valid)
        } catch (err) {
          onError?.("error", err instanceof Error ? err.message : String(err))
        }
      }
    }
    setOpen(false)
    e.target.value = "" // reset so the same files can be chosen again
  }

  const onVoiceStart = async () => {
    void selectionFeedback()
    const result = await withPlugin(voiceLoader, async (rec) => {
      const has = await rec.hasAudioRecordingPermission()
      const granted = has.value ? true : (await rec.requestAudioRecordingPermission()).value
      if (!granted) return { kind: "permission_denied" as const }
      const ok = await rec.startRecording()
      if (!ok.value) return { kind: "cannot_start" as const }
      return { kind: "started" as const }
    })
    if (result && "kind" in result && result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    if (result && "kind" in result && result.kind === "error") {
      onError?.("error", result.message)
      return
    }
    if (result && "kind" in result && result.kind === "permission_denied") {
      onError?.("permission", t("permissionDeniedMic"))
      return
    }
    if (result && "kind" in result && result.kind === "cannot_start") {
      onError?.("error", t("voiceCannotStart"))
      return
    }
    setRecording(true)
  }

  const onVoiceStop = async () => {
    const result = await withPlugin(voiceLoader, async (rec) => rec.stopRecording())
    setRecording(false)
    setOpen(false)
    if (result && "kind" in result && (result.kind === "unsupported" || result.kind === "error")) {
      onError?.("error", t("voiceStopFailed"))
      return
    }
    const v = (
      result as { value: { recordDataBase64: string; mimeType: string; msDuration: number } }
    ).value
    onAttach({
      kind: "voice",
      recordingDataUrl: `data:${v.mimeType};base64,${v.recordDataBase64}`,
      mimeType: v.mimeType,
      durationMs: v.msDuration,
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn(className)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("toggleAria")}
            className="touch-target rounded-full text-muted-foreground"
            data-testid="composer-plus-toggle"
          >
            {open ? <XIcon /> : <PaperclipIcon />}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          role="menu"
          data-testid="composer-plus-menu"
          className="grid w-64 grid-cols-3 gap-2 rounded-xl border border-border bg-background p-3 shadow-lg"
        >
          <PlusItem
            icon={<CameraIcon className="size-5" />}
            label={t("camera")}
            onSelect={onCamera}
            testId="composer-plus-camera"
          />
          <PlusItem
            icon={<ImageIcon className="size-5" />}
            label={t("album")}
            onSelect={onAlbum}
            testId="composer-plus-album"
          />
          <label
            className="flex flex-col items-center gap-1 rounded-md p-2 text-center text-xs active:bg-muted/60"
            data-testid="composer-plus-file"
          >
            <FileIcon className="size-5" />
            <span>{t("file")}</span>
            <input
              type="file"
              multiple
              accept={fileAccept}
              className="sr-only"
              onChange={onFilePicked}
              data-testid="composer-plus-file-input"
            />
          </label>
          {!showVoice ? null : recording ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void onVoiceStop()}
              className="col-span-3 gap-2 text-xs"
              data-testid="composer-plus-voice-stop"
            >
              <MicIcon className="animate-pulse" />
              <span>{t("voiceStop")}</span>
            </Button>
          ) : (
            <PlusItem
              icon={<MicIcon className="size-5" />}
              label={t("voice")}
              onSelect={() => void onVoiceStart()}
              testId="composer-plus-voice"
            />
          )}
        </PopoverContent>
      </div>
    </Popover>
  )
}

interface PlusItemProps {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  testId?: string
}

function PlusItem({ icon, label, onSelect, testId }: PlusItemProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="menuitem"
      onClick={onSelect}
      data-testid={testId}
      className="h-auto flex-col items-center gap-1 p-2 text-center text-xs font-normal"
    >
      {icon}
      <span>{label}</span>
    </Button>
  )
}

// ---------------------------------------------------------------------------
// SendContent packing helpers (Mobile completeness Phase 2.5)
//
// `SendContent` already accepts an `image` block with inline base64
// (`{ type: "image", source: { type: "base64", data, media_type } }`), so
// no new RPC is required. These helpers translate the camera / album /
// file results into that shape so the chat composer can ship the image
// through `onSend`'s normal path (`claude_send` → SDK image block).
// ---------------------------------------------------------------------------

export function packPhotoAsSendContent(base64: string, mime: string): SendContentBlock[] {
  return [
    {
      type: "image",
      source: { type: "base64", media_type: mime, data: base64 },
    },
  ]
}

async function packUriAsImageBlock(item: {
  uri: string
  mime: string
}): Promise<SendContentBlock | null> {
  if (typeof fetch !== "function") return null
  const response = await fetch(item.uri)
  const blob = await response.blob()
  const data = await blobToBase64(blob)
  if (!data) return null
  return {
    type: "image",
    source: { type: "base64", media_type: item.mime, data },
  }
}

async function packFileAsImageBlock(file: File): Promise<SendContentBlock | null> {
  const data = await blobToBase64(file)
  if (!data) return null
  return {
    type: "image",
    source: { type: "base64", media_type: file.type || "image/jpeg", data },
  }
}

/**
 * Fold a plus-menu attachment into plain `File`s so hosts with a file-based
 * attachment pipeline (the shared chat composer's `acceptFiles`) can reuse
 * their existing size/count/type gates instead of growing a parallel path.
 * Voice payloads become an audio File; hosts that can't send audio should
 * hide the branch via `showVoice={false}` rather than dropping it here.
 */
export async function attachmentToFiles(attachment: ComposerAttachment): Promise<File[]> {
  switch (attachment.kind) {
    case "file":
      return [attachment.file]
    case "files":
      return attachment.files
    case "photo": {
      const source = attachment.base64
        ? `data:${attachment.mime};base64,${attachment.base64}`
        : attachment.uri
      if (!source) return []
      const blob = await (await fetch(source)).blob()
      const ext = attachment.mime.split("/")[1] ?? "jpeg"
      return [new File([blob], `photo-${Date.now()}.${ext}`, { type: attachment.mime })]
    }
    case "photos": {
      const files = await Promise.all(
        attachment.items.map(async (item, i) => {
          const blob = await (await fetch(item.uri)).blob()
          const ext = item.mime.split("/")[1] ?? "jpeg"
          return new File([blob], `photo-${Date.now()}-${i}.${ext}`, { type: item.mime })
        })
      )
      return files
    }
    case "voice": {
      const blob = await (await fetch(attachment.recordingDataUrl)).blob()
      const ext = attachment.mimeType.includes("aac") ? "aac" : "webm"
      return [new File([blob], `voice-${Date.now()}.${ext}`, { type: attachment.mimeType })]
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : ""
      const base64 = url.includes(",") ? (url.split(",")[1] ?? "") : url
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error ?? new Error("blob read failed"))
    reader.readAsDataURL(blob)
  })
}
