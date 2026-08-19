"use client"

// Status pill rendered at the bottom of the composer showing the active
// permission mode. Clicking it cycles through the SAFE CORE only (default →
// acceptEdits → plan → default), the same cycle as Shift+Tab on the textarea —
// the danger `bypassPermissions` / power modes are reachable only via the
// status-bar Advanced group or settings, so a misclick can never land on a
// no-guardrail mode. Tooltip explains what each mode does.

import { useTranslations } from "next-intl"
import { useChatStore, type PermissionMode } from "@/stores/chat"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  cyclePermissionMode,
  permissionModeMeta,
  permissionRiskMarker,
} from "@/lib/settings/permission-mode-meta"

/** The next mode when the chip is clicked / Shift+Tab is pressed (safe core). */
export function nextPermissionMode(cur: PermissionMode | null): PermissionMode | null {
  return cyclePermissionMode(cur)
}

export interface PermissionModeIndicatorProps {
  /**
   * Called when the user clicks the chip. The composer keeps the per-session
   * persistence — this component just emits the desired next mode.
   */
  onCycle: (next: PermissionMode | null) => void
  /** Disable the indicator externally (e.g. while a turn is streaming). */
  disabled?: boolean
  /** Host styling; merged before the per-mode tone so the tone colour still wins. */
  className?: string
}

export function PermissionModeIndicator({
  onCycle,
  disabled,
  className,
}: PermissionModeIndicatorProps) {
  const t = useTranslations("chat.permissionMode")
  const mode = useChatStore((s) => s.permissionMode)
  const meta = permissionModeMeta(mode ?? "default")
  const label = t(`${meta.i18nKey}.label`)
  const tooltip = t(`${meta.i18nKey}.tooltip`)
  const marker = permissionRiskMarker(mode ?? "default")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onCycle(nextPermissionMode(mode))}
          className={cn(
            "h-auto min-w-0 shrink px-2 py-0.5 text-[11px] font-normal transition-colors hover:bg-accent",
            className,
            meta.tone
          )}
          aria-label={t("aria", { label })}
        >
          {/* The `⇧⇥` keycap that used to prefix this label taught the cycle
              shortcut on every turn, forever, in a mono face that made the chip
              read as a third typeface on the composer's status line. The hint
              lives in the tooltip below, where it is read once and costs the
              row nothing. */}
          <span className="min-w-0 truncate">
            {marker ? `${marker} ` : ""}
            {label}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{tooltip}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("shiftTabHint")}</p>
      </TooltipContent>
    </Tooltip>
  )
}
