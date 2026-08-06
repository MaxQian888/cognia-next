"use client"

/**
 * Color + icon picker popover for terminal tab customization.
 *
 * Rendered inside the context menu or as a standalone popover trigger.
 * Owns no store access — parent provides the current appearance and
 * an onChange callback.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  TAB_COLOR_PRESETS,
  TAB_ICON_PRESETS,
  TAB_COLOR_CLASSES,
  type TabColorPreset,
  type TabIconPreset,
} from "@/lib/terminal/tab-appearance"
import { TAB_ICON_COMPONENTS } from "@/lib/terminal/tab-icon-map"

export interface TerminalTabAppearancePickerProps {
  color: TabColorPreset
  icon: TabIconPreset
  onChange: (appearance: { color?: TabColorPreset; icon?: TabIconPreset }) => void
  /** Optional trigger element. Falls back to a small button with the current color dot. */
  trigger?: React.ReactNode
}

export function TerminalTabAppearancePicker({
  color,
  icon,
  onChange,
  trigger,
}: TerminalTabAppearancePickerProps) {
  const t = useTranslations("terminal.tab.appearance")

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label={t("trigger")}
            data-testid="tab-appearance-trigger"
          >
            <span
              className={cn(
                "inline-block h-3 w-3 rounded-full border",
                color !== "none" ? TAB_COLOR_CLASSES[color].dot : "bg-muted-foreground/40"
              )}
            />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start" data-testid="tab-appearance-popover">
        {/* Color section */}
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("colorLabel")}</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("colorLabel")}>
            {TAB_COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={color === preset}
                aria-label={t(`colors.${preset}`)}
                title={t(`colors.${preset}`)}
                data-testid={`tab-color-${preset}`}
                onClick={() => onChange({ color: preset })}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md border transition-colors",
                  color === preset
                    ? "border-foreground ring-1 ring-foreground/30"
                    : "border-border hover:border-foreground/50"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-sm",
                    preset === "none" ? "bg-muted-foreground/30" : TAB_COLOR_CLASSES[preset].dot
                  )}
                />
              </button>
            ))}
          </div>
        </div>
        {/* Icon section */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("iconLabel")}</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("iconLabel")}>
            {TAB_ICON_PRESETS.map((preset) => {
              const IconComp = TAB_ICON_COMPONENTS[preset]
              return (
                <button
                  key={preset}
                  type="button"
                  role="radio"
                  aria-checked={icon === preset}
                  aria-label={t(`icons.${preset}`)}
                  title={t(`icons.${preset}`)}
                  data-testid={`tab-icon-${preset}`}
                  onClick={() => onChange({ icon: preset })}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-md border transition-colors",
                    icon === preset
                      ? "border-foreground ring-1 ring-foreground/30"
                      : "border-border hover:border-foreground/50"
                  )}
                >
                  {IconComp ? (
                    <IconComp className="h-3.5 w-3.5" />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">—</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default TerminalTabAppearancePicker
