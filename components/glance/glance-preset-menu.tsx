"use client"

/**
 * The preset switch (ADR-0225 §2, §3): shows which preset the layout is (or
 * "Custom" once edited) and resets the layout to any built-in preset. Applying
 * a preset replaces module order, sizes and visibility, never width, height,
 * scope or module options.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GLANCE_PRESET_LABEL_KEYS } from "@/lib/glance/presets"
import { cn } from "@/lib/utils"
import {
  GLANCE_PRESET_IDS,
  type GlancePanelSettings,
  type GlancePresetId,
} from "@/types/glance/layout"

export interface GlancePresetMenuProps {
  preset: GlancePanelSettings["preset"]
  onApply: (preset: GlancePresetId) => void
  disabled?: boolean
  className?: string
  align?: "start" | "end"
  side?: "top" | "bottom"
}

export function GlancePresetMenu({
  preset,
  onApply,
  disabled,
  className,
  align = "start",
  side = "bottom",
}: GlancePresetMenuProps) {
  const t = useTranslations("glance")
  const current = preset === "custom" ? t("editor.custom") : t(GLANCE_PRESET_LABEL_KEYS[preset])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t("editor.presetLabel", { preset: current })}
          className={cn(
            "inline-flex min-w-0 items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
            className
          )}
        >
          <span className="truncate">{current}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="w-56">
        <DropdownMenuLabel className="text-xs">{t("editor.presets")}</DropdownMenuLabel>
        {GLANCE_PRESET_IDS.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => onApply(id)}>
            <CheckIcon className={cn("size-3.5", preset !== id && "invisible")} />
            {t(GLANCE_PRESET_LABEL_KEYS[id])}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("editor.presetHint")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
