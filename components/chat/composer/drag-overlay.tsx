"use client"

// Full-bleed dashed-border overlay shown while a file is being dragged
// over the composer. Pure presentation — visibility is driven by the
// composer's own dragenter/dragleave counter since `<PromptInput>` does
// not expose its drag state.

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { UploadCloudIcon } from "lucide-react"

interface DragOverlayProps {
  visible: boolean
  label?: string
}

export function DragOverlay({ visible, label }: DragOverlayProps) {
  const t = useTranslations("chat.composer.dragOverlay")
  const text = label ?? t("dropToAttach")
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/85 backdrop-blur-sm transition-opacity",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <UploadCloudIcon className="size-5" />
        {text}
      </div>
    </div>
  )
}
