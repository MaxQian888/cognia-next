"use client"

/**
 * OCR sidebar item — sibling of `components/settings/provider/provider-sidebar-item.tsx`.
 *
 * Visually mirrors the model-provider item (icon + name + subtitle + status
 * badge) but carries OCR-specific status semantics (5 variants) and an icon
 * letter map keyed to OCR provider ids.
 */

import React, { useCallback } from "react"
import { AlertTriangle, Ban, Check, Circle, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type OcrProviderStatus = "ready" | "connected" | "not-configured" | "unsupported" | "error"

interface OcrSidebarItemProps {
  providerId: string
  name: string
  subtitle: string
  status: OcrProviderStatus
  /** Renders the row at 60% opacity. Status badge color is unchanged. */
  disabled?: boolean
  isSelected: boolean
  onClick: (providerId: string) => void
  /** Optional override — defaults to a letter from OCR_ICON_MAP. */
  icon?: React.ReactNode
  /** Tiny status label, localized in the parent. */
  statusLabel: string
}

const STATUS_CONFIG: Record<
  OcrProviderStatus,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  ready: {
    icon: Check,
    className:
      "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
  },
  connected: {
    icon: Check,
    className:
      "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
  },
  "not-configured": {
    icon: Circle,
    className: "border-muted-foreground/20 bg-muted/50 text-muted-foreground",
  },
  unsupported: {
    icon: Ban,
    className: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  },
  error: {
    icon: X,
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
  },
}

/** Single-letter icon per provider id (case-insensitive substring match). */
export const OCR_ICON_MAP: Array<readonly [RegExp, string]> = [
  [/mistral/, "M"],
  [/google/, "G"],
  [/aws|textract/, "A"],
  [/azure/, "Z"],
  [/anthropic/, "C"],
  [/openai/, "O"],
  [/gemini/, "I"],
  [/mathpix/, "X"],
  [/ocr-space/, "S"],
  [/abbyy/, "B"],
  [/nanonets/, "N"],
  [/lark/, "L"],
  [/tesseract-wasm/, "T"],
  [/tesseract-native/, "T"],
  [/windows/, "W"],
  [/apple/, "V"],
  [/mlkit/, "K"],
  [/ocrs/, "R"],
  [/paddle/, "P"],
  [/local-http/, "H"],
]

export function ocrProviderInitial(providerId: string): string {
  const id = providerId.toLowerCase()
  for (const [pat, letter] of OCR_ICON_MAP) {
    if (pat.test(id)) return letter
  }
  return providerId.charAt(0).toUpperCase()
}

/** Renders one OCR sidebar row. */
export const OcrSidebarItem = React.memo(function OcrSidebarItem({
  providerId,
  name,
  subtitle,
  status,
  disabled = false,
  isSelected,
  onClick,
  icon,
  statusLabel,
}: OcrSidebarItemProps) {
  const handleClick = useCallback(() => onClick(providerId), [onClick, providerId])
  const statusCfg = STATUS_CONFIG[status]
  const StatusIcon = statusCfg.icon

  // Render `disabled` on the wrapper without `disabled` attribute — the row
  // is still clickable so users can re-enable from the detail panel.
  const ariaDisabled = AriaWhen(disabled)

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={`ocr-sidebar-item-${providerId}`}
      data-status={status}
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={ariaDisabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
        isSelected
          ? "border-l-2 border-l-primary bg-primary text-primary-foreground"
          : "hover:bg-muted/50",
        disabled && !isSelected && "opacity-60"
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
          isSelected ? "bg-primary-foreground/20" : "bg-muted"
        )}
      >
        {icon ?? ocrProviderInitial(providerId)}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span
          className={cn(
            "block truncate text-xs",
            isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {subtitle}
        </span>
      </div>
      <Badge
        variant="outline"
        className={cn("shrink-0 gap-1 text-[10px] px-1.5 py-0", statusCfg.className)}
      >
        <StatusIcon className="h-3 w-3" />
        <span className="hidden sm:inline">{statusLabel}</span>
      </Badge>
      {disabled && (
        <AlertTriangle className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  )
})

function AriaWhen(value: boolean): "true" | undefined {
  return value ? "true" : undefined
}
