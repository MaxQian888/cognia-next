"use client"

// Tauri-only button that captures the screen via `getDisplayMedia` and
// pipes the result into the composer's attachments. Hidden when not
// running inside Tauri to avoid prompting browser users for screen
// share when the action would be useless.

import { useTranslations } from "next-intl"
import { CameraIcon } from "lucide-react"
import { toast } from "sonner"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { loggers } from "@cognia/logging"

interface ScreenshotButtonProps {
  disabled?: boolean
}

export function ScreenshotButton({ disabled }: ScreenshotButtonProps) {
  const t = useTranslations("chat.composer.screenshot")
  const attachments = usePromptInputAttachments()

  const onClick = async () => {
    try {
      const file = await captureScreenshot()
      if (!file) return
      attachments.add([file])
    } catch (err) {
      loggers.chat.warn("screenshot capture failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      toast.error(err instanceof Error ? err.message : t("captureFailed"))
    }
  }

  return (
    <TooltipIconButton
      aria-label={t("captureAria")}
      tooltip={t("captureTooltip")}
      className="size-8"
      disabled={disabled}
      onClick={() => void onClick()}
      size="icon"
      type="button"
    >
      <CameraIcon className="size-4" />
    </TooltipIconButton>
  )
}
