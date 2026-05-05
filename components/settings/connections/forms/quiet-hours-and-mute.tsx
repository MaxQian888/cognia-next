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

export function QuietHoursAndMute({
  muted,
  onMutedChange,
  quietHours,
  onQuietHoursChange,
  disabled,
}: QuietHoursAndMuteProps) {
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
            Globally muted
          </Label>
          <p className="text-xs text-muted-foreground">
            Suppress all outbound messages until unmuted.
          </p>
        </div>
        <Switch
          id="qhm-muted"
          checked={muted}
          onCheckedChange={onMutedChange}
          disabled={disabled}
          aria-label="Mute adapter"
        />
      </div>

      {/* Quiet hours toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="qhm-enable" className="text-sm font-medium">
            Quiet hours
          </Label>
          <p className="text-xs text-muted-foreground">
            Defer outbound messages during these hours.
          </p>
        </div>
        <Switch
          id="qhm-enable"
          checked={qhEnabled}
          onCheckedChange={handleToggleQH}
          disabled={disabled}
          aria-label="Enable quiet hours"
        />
      </div>

      {/* Quiet hours fields */}
      {qhEnabled && quietHours && (
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label htmlFor="qhm-from" className="text-xs">
              From (HH:MM)
            </Label>
            <Input
              id="qhm-from"
              type="time"
              value={quietHours.from}
              onChange={(e) => onQuietHoursChange({ ...quietHours, from: e.target.value })}
              disabled={disabled}
              aria-label="Quiet hours from"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qhm-to" className="text-xs">
              To (HH:MM)
            </Label>
            <Input
              id="qhm-to"
              type="time"
              value={quietHours.to}
              onChange={(e) => onQuietHoursChange({ ...quietHours, to: e.target.value })}
              disabled={disabled}
              aria-label="Quiet hours to"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qhm-tz" className="text-xs">
              Timezone
            </Label>
            <select
              id="qhm-tz"
              value={quietHours.tz}
              onChange={(e) => onQuietHoursChange({ ...quietHours, tz: e.target.value })}
              disabled={disabled}
              aria-label="Quiet hours timezone"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {COMMON_TZ.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
