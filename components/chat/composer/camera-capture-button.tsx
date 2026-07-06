"use client"

// Mobile-native counterpart to ScreenshotButton: a phone has no desktop screen
// to capture, so "attach a fresh visual" maps to a camera capture. Reuses
// `lib/capacitor/camera.pickPhoto` (native `@capacitor/camera` + a web
// `<input capture>` fallback, with permission/cancel handling) and the same
// attachments sink as the screenshot button, so the photo flows through the
// existing OCR menu / draft persistence / send pipeline unchanged.

import { useTranslations } from "next-intl"
import { CameraIcon } from "lucide-react"
import { toast } from "sonner"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { pickPhoto } from "@/lib/capacitor/camera"
import { loggers } from "@/lib/logging"

interface CameraCaptureButtonProps {
  disabled?: boolean
}

export function CameraCaptureButton({ disabled }: CameraCaptureButtonProps) {
  const t = useTranslations("chat.composer.camera")
  const attachments = usePromptInputAttachments()

  const onClick = async () => {
    // "prompt" lets the native sheet offer camera OR gallery; the web fallback
    // drops the `capture` hint so the system picker isn't pinned to the camera.
    const outcome = await pickPhoto({ source: "prompt", resultType: "dataUrl" })
    switch (outcome.kind) {
      case "captured": {
        if (!outcome.dataUrl) {
          toast.error(t("captureFailed"))
          return
        }
        try {
          const blob = await (await fetch(outcome.dataUrl)).blob()
          const ext = outcome.format || "jpeg"
          const type = blob.type || `image/${ext}`
          const file = new File([blob], `photo-${Date.now()}.${ext}`, { type })
          attachments.add([file])
        } catch (err) {
          loggers.chat.warn("camera capture attach failed", {
            err: err instanceof Error ? err.message : String(err),
          })
          toast.error(t("captureFailed"))
        }
        return
      }
      case "permission_denied":
        toast.error(t("permissionDenied"))
        return
      case "cancelled":
        return
      case "unsupported":
        toast.error(t("unsupported"))
        return
      default:
        toast.error(t("captureFailed"))
    }
  }

  return (
    <TooltipIconButton
      aria-label={t("captureAria")}
      tooltip={t("captureTooltip")}
      className="size-8 touch-target"
      disabled={disabled}
      onClick={() => void onClick()}
      size="icon"
      type="button"
    >
      <CameraIcon className="size-4" />
    </TooltipIconButton>
  )
}
