"use client"

/**
 * QuietHoursAndMute — shared component for all 5 adapter config dialogs.
 *
 * Renders:
 *   - A muted Switch (globally suppresses outbound when on).
 *   - quietHours from / to time inputs + timezone selector.
 *
 * Used by telegram-config, discord-config, slack-config, lark-config,
 * and onebot-config. The parent dialog is responsible for persisting
 * the values via updateAdapterInstance.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

export interface QuietHoursValue {
  from: string
  to: string
  tz: string
}

interface QuietHoursAndMuteProps {
  muted: boolean
  onMutedChange: (v: boolean) => void
  quietHours: QuietHoursValue | null
  onQuietHoursChange: (v: QuietHoursValue | null) => void
  disabled?: boolean
}

/** Common IANA timezone list for the selector. */
const COMMON_TZ = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
]

/** Sentinel value the timezone <select> uses to switch into freeform mode. */
const CUSTOM_TZ_VALUE = "__custom__"

/**
 * Validate an IANA timezone string. `Intl.DateTimeFormat` throws RangeError
 * on unknown zones, which is what we want — wrap in try/catch and return
 * boolean. Pure: no side effects.
 */
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function QuietHoursAndMute({
  muted,
  onMutedChange,
  quietHours,
  onQuietHoursChange,
  disabled,
}: QuietHoursAndMuteProps) {
  const t = useTranslations("settings.connections.quietHours")
  const qhEnabled = quietHours !== null

  function handleToggleQH(checked: boolean) {
    if (checked) {
      onQuietHoursChange({ from: "22:00", to: "08:00", tz: "UTC" })
    } else {
      onQuietHoursChange(null)
    }
  }

  return (
    <div className="space-y-4">
      <Separator />

      {/* Mute toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="qhm-muted" className="text-sm font-medium">
            {t("mutedLabel")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("mutedHelp")}</p>
        </div>
        <Switch
          id="qhm-muted"
          checked={muted}
          onCheckedChange={onMutedChange}
          disabled={disabled}
          aria-label={t("mutedAria")}
        />
      </div>

      {/* Quiet hours toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="qhm-enable" className="text-sm font-medium">
            {t("enableLabel")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>
        </div>
        <Switch
          id="qhm-enable"
          checked={qhEnabled}
          onCheckedChange={handleToggleQH}
          disabled={disabled}
          aria-label={t("enableAria")}
        />
      </div>

      {/* Quiet hours fields. grid-cols-1 on narrow screens stacks the
       *  from/to/timezone inputs so they don't overflow on small phones;
       *  sm:grid-cols-3 brings them back side-by-side on tablets+. */}
      {qhEnabled && quietHours && (
        <QuietHoursFields value={quietHours} onChange={onQuietHoursChange} disabled={disabled} />
      )}
    </div>
  )
}

interface QuietHoursFieldsProps {
  value: QuietHoursValue
  onChange: (v: QuietHoursValue) => void
  disabled?: boolean
}

/**
 * Inner from / to / timezone trio. Pulled into a sub-component so the
 * "custom timezone" state stays local — the parent owns the canonical
 * `quietHours` value while this child manages whether the user has the
 * common-zone dropdown open or has flipped into the custom-input mode.
 */
function QuietHoursFields({ value, onChange, disabled }: QuietHoursFieldsProps) {
  const t = useTranslations("settings.connections.quietHours")

  // If the persisted tz is one of the common ones, start in dropdown mode.
  // Otherwise the user must have entered a custom one — start in custom mode.
  const initialIsCustom = !COMMON_TZ.includes(value.tz)
  const [isCustom, setIsCustom] = useState<boolean>(initialIsCustom)
  const tzValid = isValidIanaTimezone(value.tz)

  const onSelectChange = (next: string): void => {
    if (next === CUSTOM_TZ_VALUE) {
      setIsCustom(true)
      // Keep the current value as the seed for the freeform input so the
      // operator doesn't lose what they had.
      return
    }
    setIsCustom(false)
    onChange({ ...value, tz: next })
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="qhm-from" className="text-xs">
          {t("fromLabel")}
        </Label>
        <Input
          id="qhm-from"
          type="time"
          value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          disabled={disabled}
          aria-label={t("fromAria")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="qhm-to" className="text-xs">
          {t("toLabel")}
        </Label>
        <Input
          id="qhm-to"
          type="time"
          value={value.to}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          disabled={disabled}
          aria-label={t("toAria")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="qhm-tz" className="text-xs">
          {t("timezoneLabel")}
        </Label>
        {isCustom ? (
          <Input
            id="qhm-tz"
            type="text"
            value={value.tz}
            onChange={(e) => onChange({ ...value, tz: e.target.value })}
            disabled={disabled}
            aria-label={t("timezoneAria")}
            placeholder={t("timezonePlaceholder")}
            data-testid="qhm-tz-custom-input"
            aria-invalid={value.tz.length > 0 && !tzValid}
            className="h-9 text-xs"
          />
        ) : (
          <select
            id="qhm-tz"
            value={COMMON_TZ.includes(value.tz) ? value.tz : CUSTOM_TZ_VALUE}
            onChange={(e) => onSelectChange(e.target.value)}
            disabled={disabled}
            aria-label={t("timezoneAria")}
            data-testid="qhm-tz-select"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {COMMON_TZ.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            <option value={CUSTOM_TZ_VALUE}>{t("timezoneCustomOption")}</option>
          </select>
        )}
        {isCustom && value.tz.length > 0 && !tzValid && (
          <p className="text-[10px] text-destructive" data-testid="qhm-tz-invalid">
            {t("timezoneInvalid")}
          </p>
        )}
      </div>
    </div>
  )
}
