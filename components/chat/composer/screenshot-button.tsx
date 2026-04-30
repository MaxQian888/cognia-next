"use client"

// Tauri-only button that captures the screen via `getDisplayMedia` and
// pipes the result into the composer's attachments. Hidden when not
// running inside Tauri to avoid prompting browser users for screen
// share when the action would be useless.

import { useTranslations } from "next-intl"
import { CameraIcon } from "lucide-react"
import { toast } from "sonner"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { loggers } from "@/lib/logger"

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={t("captureAria")}
          className="size-8"
          disabled={disabled}
          onClick={() => void onClick()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <CameraIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("captureTooltip")}</TooltipContent>
    </Tooltip>
  )
}
