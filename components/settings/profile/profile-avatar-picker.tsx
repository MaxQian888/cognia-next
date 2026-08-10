"use client"

/**
 * Avatar file picker for the user profile. A picked file opens the crop/zoom
 * edit dialog ({@link AvatarEditDialog}); only that dialog's output — a
 * downscaled, size-capped data URL from `lib/profile/avatar-image.ts` — ever
 * reaches the settings row, never a raw FileReader result (the profile blob
 * syncs to companion devices and rides WebDAV backups).
 */

import { Input } from "@/components/ui/input"
import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ImagePlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { isAcceptedAvatarType } from "@/lib/profile/avatar-image"

import { AvatarEditDialog } from "./avatar-edit-dialog"

export interface ProfileAvatarPickerProps {
  /** Current avatar data URL (null → glyph fallback). */
  value: string | null
  /** Name used for the glyph fallback + deterministic color. */
  fallbackName: string
  onChange: (dataUrl: string | null) => void | Promise<void>
  disabled?: boolean
}

export function ProfileAvatarPicker({
  value,
  fallbackName,
  onChange,
  disabled,
}: ProfileAvatarPickerProps) {
  const t = useTranslations("settings.profile")
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The file currently being cropped in the edit dialog (null → dialog closed).
  const [editing, setEditing] = useState<File | null>(null)

  const handleFile = (file: File) => {
    if (!isAcceptedAvatarType(file.type)) {
      toast.error(t("avatarInvalidType"))
      return
    }
    setEditing(file)
  }

  const busy = editing != null

  return (
    <div className="flex items-center gap-4" data-testid="profile-avatar-picker">
      <AvatarBadge
        subject={{ name: fallbackName, avatarImageUrl: value ?? undefined }}
        size={64}
        textClassName="text-xl"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            data-testid="profile-avatar-upload"
          >
            <ImagePlusIcon className="size-4" />
            {t("avatarUpload")}
          </Button>
          {value ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => void onChange(null)}
              data-testid="profile-avatar-clear"
            >
              <Trash2Icon className="size-4" />
              {t("avatarClear")}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("avatarHint")}</p>
      </div>
      <Input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="hidden"
        aria-label={t("avatarLabel")}
        data-testid="profile-avatar-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Allow re-picking the same file after cancel/failure.
          e.target.value = ""
          if (file) handleFile(file)
        }}
      />
      <AvatarEditDialog
        file={editing}
        onCancel={() => setEditing(null)}
        onConfirm={async (dataUrl) => {
          await onChange(dataUrl)
          setEditing(null)
        }}
      />
    </div>
  )
}
