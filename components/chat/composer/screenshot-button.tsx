"use client"

// Tauri-only button that captures the screen via `getDisplayMedia` and
// pipes the result into the composer's attachments. Hidden when not
// running inside Tauri to avoid prompting browser users for screen
// share when the action would be useless.

import { CameraIcon } from "lucide-react"
import { toast } from "sonner"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { captureScreenshot } from "@/lib/screenshot"

interface ScreenshotButtonProps {
  disabled?: boolean
}

export function ScreenshotButton({ disabled }: ScreenshotButtonProps) {
  const attachments = usePromptInputAttachments()

  const onClick = async () => {
    try {
      const file = await captureScreenshot()
      if (!file) return
      attachments.add([file])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Screenshot failed")
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Capture screenshot"
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
      <TooltipContent>Capture screenshot</TooltipContent>
    </Tooltip>
  )
}
