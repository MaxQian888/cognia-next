"use client"

// Drag-and-drop / file picker for new wallpaper images. Validates mime
// type + size on the client, extracts dimensions via the loaded `Image`,
// and yields the bytes + meta to the caller.

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ImagePlusIcon, Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { MAX_WALLPAPER_BYTES } from "@/lib/appearance/wallpaper-storage"
import { readImageDimensions } from "@/lib/appearance/image-utils"

export interface UploadedWallpaper {
  bytes: ArrayBuffer
  mime: string
  width: number
  height: number
  /** Original `File.name`. Caller may use it for the wallpaper display name. */
  fileName: string
}

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]

export interface WallpaperUploaderProps {
  onUpload: (file: UploadedWallpaper) => Promise<void> | void
  /** Disable the dropzone (e.g. while a save is in flight elsewhere). */
  disabled?: boolean
}

export function WallpaperUploader({ onUpload, disabled }: WallpaperUploaderProps) {
  const t = useTranslations("settings.appearance.wallpaper")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      if (!ACCEPTED.includes(file.type)) {
        setError(t("invalidType"))
        return
      }
      if (file.size > MAX_WALLPAPER_BYTES) {
        setError(t("tooLarge"))
        return
      }
      setBusy(true)
      try {
        const bytes = await file.arrayBuffer()
        const dims = await readImageDimensions(file)
        await onUpload({
          bytes,
          mime: file.type,
          width: dims.width,
          height: dims.height,
          fileName: file.name,
        })
      } catch (err) {
        setError((err as Error).message ?? "upload failed")
      } finally {
        setBusy(false)
      }
    },
    [onUpload, t]
  )

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (disabled) return
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void handleFile(file)
      }}
      data-testid="wallpaper-dropzone"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm transition",
        dragOver ? "border-primary bg-primary/5" : "border-border",
        disabled && "opacity-50"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
          e.target.value = ""
        }}
      />
      <div className="flex items-center gap-2 text-muted-foreground">
        {busy ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <ImagePlusIcon className="size-4" />
        )}
        <span>{busy ? t("uploading") : t("dropHint")}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {t("browse")}
      </Button>
      <p className="text-[11px] text-muted-foreground">{t("formats")}</p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
