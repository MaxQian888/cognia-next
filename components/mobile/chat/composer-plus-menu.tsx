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
 *   - Voice    → `@capacitor-community/voice-recorder` (loaded lazily so
 *                the web bundle skips the native module)
 *
 * The menu is purely an action launcher — the chosen attachment is
 * forwarded to `onAttach(payload)` so the chat-room component can persist
 * + enqueue an outbound `connector_send` job as appropriate.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CameraIcon, FileIcon, ImageIcon, MicIcon, PaperclipIcon, XIcon } from "lucide-react"

import { pickMultiplePhotos, pickPhoto } from "@/lib/capacitor/camera"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { showToast } from "@/lib/capacitor/toast"
import { makeDefaultLoader, withPlugin } from "@/lib/capacitor/_shared"
import { cn } from "@/lib/utils"

export type ComposerAttachment =
  | { kind: "photo"; base64?: string; uri?: string; mime: string }
  | { kind: "photos"; items: Array<{ uri: string; mime: string }> }
  | { kind: "file"; file: File }
  | { kind: "voice"; recordingDataUrl: string; mimeType: string; durationMs?: number }

export interface ComposerPlusMenuProps {
  /**
   * Receives the result of whichever option the user picked. Should NOT
   * persist the message — it's the caller's job to fold the attachment
   * into a draft + outbound queue write.
   */
  onAttach: (attachment: ComposerAttachment) => void
  /** Triggered with the raw error code on failure paths (permission, etc.). */
  onError?: (code: string, message: string) => void
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
  "@capacitor-community/voice-recorder",
  "VoiceRecorder"
)

export function ComposerPlusMenu({ onAttach, onError, className }: ComposerPlusMenuProps) {
  const t = useTranslations("mobile.composerPlus")
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(false)

  const onCamera = async () => {
    setOpen(false)
    void selectionFeedback()
    const result = await pickPhoto({ source: "camera", resultType: "base64" })
    if (result.kind === "captured") {
      onAttach({
        kind: "photo",
        base64: result.base64,
        uri: result.uri,
        mime: `image/${result.format}`,
      })
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
      onAttach({
        kind: "photos",
        items: result.photos.map((p) => ({ uri: p.uri, mime: `image/${p.format}` })),
      })
      return
    }
    if (result.kind === "cancelled") return
    if (result.kind === "unsupported") {
      onError?.("unsupported", t("unsupported"))
      return
    }
    onError?.("error", result.message)
  }

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    onAttach({ kind: "file", file })
    setOpen(false)
    e.target.value = "" // reset so the same file can be chosen again
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
      onError?.("error", "Voice stop failed")
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
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("toggleAria")}
        className="touch-target flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 active:bg-muted"
        data-testid="composer-plus-toggle"
      >
        {open ? <XIcon className="size-5" /> : <PaperclipIcon className="size-5" />}
      </button>

      {open ? (
        <div
          role="menu"
          data-testid="composer-plus-menu"
          className="absolute bottom-12 left-0 z-30 grid w-64 grid-cols-3 gap-2 rounded-xl border border-border bg-background p-3 shadow-lg"
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
              className="sr-only"
              onChange={onFilePicked}
              data-testid="composer-plus-file-input"
            />
          </label>
          {recording ? (
            <button
              type="button"
              onClick={() => void onVoiceStop()}
              className="col-span-3 flex items-center justify-center gap-2 rounded-md bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground"
              data-testid="composer-plus-voice-stop"
            >
              <MicIcon className="size-4 animate-pulse" />
              <span>{t("voiceStop")}</span>
            </button>
          ) : (
            <PlusItem
              icon={<MicIcon className="size-5" />}
              label={t("voice")}
              onSelect={() => void onVoiceStart()}
              testId="composer-plus-voice"
            />
          )}
        </div>
      ) : null}
    </div>
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
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      data-testid={testId}
      className="flex flex-col items-center gap-1 rounded-md p-2 text-center text-xs active:bg-muted/60"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
