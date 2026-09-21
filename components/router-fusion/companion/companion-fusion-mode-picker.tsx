"use client"

// The "Run with Cascade / Panel" entry of the mobile remote-session composer
// (ADR-0188 D25, the `companion` surface).
//
// The desktop composer's FusionModeChip semantics, for a paired device:
// Direct sends the message as it always did; Cascade and Panel ask the host for
// a verified run of that message instead — text only, no agent tools, answer
// shown once it is checked. There is no Auto here: a phone has no router of
// its own, and the host's rule rows decide chat turns, not explicit runs.
//
// The composer mounts this only while the host reports the run healthy for
// this device, so an off switch on the host shows no entry at all.

import { useTranslations } from "next-intl"
import { Route } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export const COMPANION_COMPOSER_MODES = ["direct", "cascade", "panel"] as const
export type CompanionComposerMode = (typeof COMPANION_COMPOSER_MODES)[number]

export function isCompanionComposerMode(value: string): value is CompanionComposerMode {
  return (COMPANION_COMPOSER_MODES as readonly string[]).includes(value)
}

export interface CompanionFusionModePickerProps {
  mode: CompanionComposerMode
  onModeChange: (mode: CompanionComposerMode) => void
  disabled?: boolean
  className?: string
}

export function CompanionFusionModePicker({
  mode,
  onModeChange,
  disabled,
  className,
}: CompanionFusionModePickerProps) {
  const t = useTranslations("routerFusionCompanion.picker")
  const label = t(mode)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={mode === "direct" ? "icon" : "sm"}
          disabled={disabled}
          aria-label={t("aria", { mode: label })}
          data-testid="companion-fusion-mode"
          data-mode={mode}
          className={cn("shrink-0 gap-1", mode !== "direct" && "px-2 text-primary", className)}
        >
          <Route className="size-4 shrink-0" aria-hidden />
          {mode !== "direct" ? <span className="text-xs">{label}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-72"
        data-testid="companion-fusion-mode-menu"
      >
        <DropdownMenuLabel className="text-xs">{t("title")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (isCompanionComposerMode(value)) onModeChange(value)
          }}
        >
          {COMPANION_COMPOSER_MODES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              data-testid={`companion-fusion-mode-${option}`}
              className="items-start py-1.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-medium">{t(option)}</span>
                <span className="text-[11px] text-muted-foreground">{t(`${option}Desc`)}</span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("hint")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
