"use client"

/**
 * Canvas view-mode toggle — segmented Code / Split / Preview control that drives
 * the center-pane layout via `useCanvasLayoutStore.previewMode`. On a narrow
 * pane (or mobile) the "split" option is hidden and a persisted "split" state is
 * presented as "code" so the control never shows an option the pane can't honor.
 */

import { useTranslations } from "next-intl"
import { Code2, Columns2, Eye } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { useCanvasLayoutStore, type CanvasPreviewMode } from "@/stores/canvas/canvas-layout-store"

interface CanvasViewModeToggleProps {
  /** Hide "split" (narrow pane / mobile) — only Code ⇄ Preview. */
  compact?: boolean
  className?: string
}

function isPreviewMode(value: string): value is CanvasPreviewMode {
  return value === "code" || value === "split" || value === "preview"
}

export function CanvasViewModeToggle({ compact = false, className }: CanvasViewModeToggleProps) {
  const t = useTranslations("canvas.viewModes")
  const previewMode = useCanvasLayoutStore((s) => s.previewMode)
  const setPreviewMode = useCanvasLayoutStore((s) => s.setPreviewMode)

  // In compact mode a persisted "split" has no side-by-side layout to show, so
  // reflect it as "code" in the control (the pane renders code-only anyway).
  const value: CanvasPreviewMode = compact && previewMode === "split" ? "code" : previewMode

  const handleChange = (next: string) => {
    // Radix emits "" when the active item is re-clicked; ignore it so a mode is
    // always selected.
    if (isPreviewMode(next)) setPreviewMode(next)
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleChange}
      variant="outline"
      size="sm"
      data-testid="canvas-view-mode-toggle"
      className={cn("h-7", className)}
    >
      <ToggleGroupItem value="code" aria-label={t("codeAria")} className="h-7 gap-1 px-2 text-xs">
        <Code2 className="size-3.5" />
        <span>{t("code")}</span>
      </ToggleGroupItem>
      {!compact && (
        <ToggleGroupItem
          value="split"
          aria-label={t("splitAria")}
          className="h-7 gap-1 px-2 text-xs"
        >
          <Columns2 className="size-3.5" />
          <span>{t("split")}</span>
        </ToggleGroupItem>
      )}
      <ToggleGroupItem
        value="preview"
        aria-label={t("previewAria")}
        className="h-7 gap-1 px-2 text-xs"
      >
        <Eye className="size-3.5" />
        <span>{t("preview")}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
