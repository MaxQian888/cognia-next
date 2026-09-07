"use client"

/**
 * The one control behind both power surfaces: the per-conversation choice in
 * the session sheet, and the app-wide default in Settings. Same rows, same
 * wording, same effect line, so a user cannot read two different explanations
 * of one behaviour depending on where they opened it.
 *
 * The effect line is the point. "Let the screen go off" means something
 * different on a desktop (the sidecar keeps working) than in a lone browser tab
 * (the page can be throttled), and a picker that hid that difference would be
 * promising something it cannot deliver on one of them.
 */

import { useTranslations } from "next-intl"
import { MoonIcon, SunIcon, SlidersHorizontalIcon } from "lucide-react"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useHostProfile } from "@/hooks/use-host-profile"
import { isScreenHoldAvailable } from "@/lib/power/screen-wake-lock"
import {
  SESSION_POWER_MODES,
  SESSION_POWER_POLICIES,
  describeSessionPowerEffect,
  resolveSessionPowerMode,
} from "@/lib/power/session-power-policy"
import { cn } from "@/lib/utils"
import type { SessionPowerMode, SessionPowerPolicy } from "@cognia/agent-config-types"

const ICONS = {
  inherit: SlidersHorizontalIcon,
  keepScreenOn: SunIcon,
  allowScreenOff: MoonIcon,
} as const

export interface SessionPowerPickerProps {
  value: SessionPowerPolicy
  onValueChange: (next: SessionPowerPolicy) => void
  /**
   * Offer "follow the app default". Session scope does, the app-wide default
   * itself cannot inherit from anything.
   */
  includeInherit?: boolean
  /** What `inherit` resolves to, spelled out on the row rather than implied. */
  appDefault: SessionPowerMode
  /** Disambiguates the radio ids when both surfaces are on screen at once. */
  idPrefix: string
  className?: string
}

export function SessionPowerPicker({
  value,
  onValueChange,
  includeInherit = false,
  appDefault,
  idPrefix,
  className,
}: SessionPowerPickerProps) {
  const t = useTranslations("sessionPower")
  const profile = useHostProfile()
  const available = isScreenHoldAvailable()
  const effective = resolveSessionPowerMode(value, appDefault)
  const effect = describeSessionPowerEffect(effective, profile, available)
  const options = includeInherit ? SESSION_POWER_POLICIES : SESSION_POWER_MODES

  return (
    <div className={cn("space-y-2", className)} data-testid="session-power-picker">
      <RadioGroup
        value={value}
        onValueChange={(next) => onValueChange(next as SessionPowerPolicy)}
        className="gap-2"
      >
        {options.map((option) => {
          const Icon = ICONS[option]
          const selected = option === value
          // Kept selectable even with no lock available: refusing the choice
          // would lose it on the next device that CAN honour it.
          const inert = option === "keepScreenOn" && !available
          return (
            <label
              key={option}
              htmlFor={`${idPrefix}-${option}`}
              data-testid={`session-power-option-${option}`}
              data-selected={selected ? "true" : "false"}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-xs transition-colors",
                selected ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                inert && "opacity-70"
              )}
            >
              <RadioGroupItem value={option} id={`${idPrefix}-${option}`} className="mt-0.5" />
              <Icon aria-hidden className="mt-px size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block font-medium">{t(`policy.${option}.label`)}</span>
                <span className="block leading-4 text-muted-foreground">
                  {option === "inherit"
                    ? t("policy.inherit.description", { mode: t(`policy.${appDefault}.label`) })
                    : t(`policy.${option}.description`)}
                </span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
      <p className="text-[11px] leading-4 text-muted-foreground" data-testid="session-power-effect">
        {t(`effect.${effect}`)}
      </p>
    </div>
  )
}

export default SessionPowerPicker
