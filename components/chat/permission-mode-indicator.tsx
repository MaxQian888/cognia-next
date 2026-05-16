"use client"

// Status pill rendered at the bottom of the composer showing the active
// permission mode. Clicking it cycles through the modes (default →
// acceptEdits → plan → bypassPermissions → default), the same cycle as
// Shift+Tab on the textarea. Tooltip explains what each mode does.

import { useTranslations } from "next-intl"
import { useChatStore, type PermissionMode } from "@/stores/chat"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const ORDER: (PermissionMode | null)[] = [null, "acceptEdits", "plan", "bypassPermissions"]

const TONE_BY_MODE: Record<string, string> = {
  null: "text-muted-foreground",
  acceptEdits: "text-blue-500",
  plan: "text-amber-500",
  bypassPermissions: "text-rose-500",
}

const TRANSLATION_KEY_BY_MODE: Record<string, "default" | "acceptEdits" | "plan" | "bypass"> = {
  null: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  bypassPermissions: "bypass",
}

export function nextPermissionMode(cur: PermissionMode | null): PermissionMode | null {
  const idx = ORDER.indexOf(cur)
  return ORDER[(idx + 1) % ORDER.length]
}

export interface PermissionModeIndicatorProps {
  /**
   * Called when the user clicks the chip. The composer keeps the per-session
   * persistence — this component just emits the desired next mode.
   */
  onCycle: (next: PermissionMode | null) => void
  /** Disable the indicator externally (e.g. while a turn is streaming). */
  disabled?: boolean
}

export function PermissionModeIndicator({ onCycle, disabled }: PermissionModeIndicatorProps) {
  const t = useTranslations("chat.permissionMode")
  const mode = useChatStore((s) => s.permissionMode)
  const key = TRANSLATION_KEY_BY_MODE[String(mode)] ?? "default"
  const label = t(`${key}.label`)
  const tooltip = t(`${key}.tooltip`)
  const toneClass = TONE_BY_MODE[String(mode)] ?? TONE_BY_MODE.null
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
            "h-auto px-2 py-0.5 font-mono text-[11px] font-normal transition-colors hover:bg-accent",
            toneClass
          )}
          aria-label={t("aria", { label })}
        >
          ⇧⇥ {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{tooltip}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("shiftTabHint")}</p>
      </TooltipContent>
    </Tooltip>
  )
}
