"use client"

// File picker for new wallpaper images. Validation and byte-reading live in
// `lib/appearance/wallpaper-intake` so this and the gallery's drop target
// can't drift apart.
//
// This component no longer draws a dropzone of its own: the gallery grid is
// the drop target now, and this renders inside a popover behind the gallery's
// "+" tile.

import { Input } from "@/components/ui/input"
import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ImagePlusIcon, Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  ACCEPTED_WALLPAPER_MIMES,
  intakeWallpaperFile,
  type UploadedWallpaper,
} from "@/lib/appearance/wallpaper-intake"

export type { UploadedWallpaper }

export interface WallpaperUploaderProps {
  onUpload: (file: UploadedWallpaper) => Promise<void> | void
  /** Disable the picker (e.g. while a save is in flight elsewhere). */
  disabled?: boolean
  className?: string
}

export function WallpaperUploader({ onUpload, disabled, className }: WallpaperUploaderProps) {
  const t = useTranslations("settings.appearance.wallpaper")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setBusy(true)
      try {
        const result = await intakeWallpaperFile(file)
        if (!result.ok) {
          setError(t(result.reason))
          return
        }
        await onUpload(result.file)
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
      data-testid="wallpaper-uploader"
      className={cn("flex flex-col items-center gap-2 text-center text-sm", className)}
    >
      <Input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_WALLPAPER_MIMES.join(",")}
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
