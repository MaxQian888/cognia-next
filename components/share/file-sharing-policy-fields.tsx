"use client"

/**
 * The fields of one file-sharing policy (ADR-0222 §6.4), edited in place.
 * Used for the person's own policy and, by owners and admins, for the org's.
 *
 * Every field is live: agent sharing (ADR-0222 §9) decides whether an agent is
 * offered `filespace_share` / `filespace_enable_webdav` at all, and the host
 * refuses an agent's grant without it.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  FILE_SHARING_TTL_PRESETS_SECONDS,
  editFileSharingPolicy,
  type FileSharingPolicy,
} from "@/lib/filespace/policy"

type FlagKey = {
  [K in keyof FileSharingPolicy]: FileSharingPolicy[K] extends boolean ? K : never
}[keyof FileSharingPolicy]
type TtlKey = "maxSnapshotTtlSeconds" | "maxLiveTtlSeconds"

interface FlagRow {
  key: FlagKey
  /** Shown nested under live access, which it needs. */
  needsLive?: boolean
}

const FLAGS: readonly FlagRow[] = [
  { key: "allowPublicSnapshots" },
  { key: "allowLiveGrants" },
  { key: "allowProtocolCredentials", needsLive: true },
  { key: "allowLiveWrite", needsLive: true },
  { key: "allowAgentSharing" },
]

const TTLS: readonly TtlKey[] = ["maxSnapshotTtlSeconds", "maxLiveTtlSeconds"]

const HOUR = 60 * 60
const DAY = 24 * HOUR

export interface FileSharingPolicyFieldsProps {
  /** Distinguishes the controls when two editors share a page. */
  idPrefix: string
  value: FileSharingPolicy
  onChange: (next: FileSharingPolicy) => void
  disabled?: boolean
}

export function FileSharingPolicyFields({
  idPrefix,
  value,
  onChange,
  disabled = false,
}: FileSharingPolicyFieldsProps) {
  const t = useTranslations("share.policy")
  const duration = (seconds: number) =>
    seconds % DAY === 0
      ? t("duration.days", { count: seconds / DAY })
      : t("duration.hours", { count: Math.round(seconds / HOUR) })

  return (
    <div className="space-y-3">
      {FLAGS.map((row) => {
        const id = `${idPrefix}-${row.key}`
        return (
          <div
            key={row.key}
            className={row.needsLive ? "flex items-start gap-3 pl-6" : "flex items-start gap-3"}
          >
            <Switch
              id={id}
              checked={value[row.key]}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(editFileSharingPolicy(value, { [row.key]: checked }))
              }
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label htmlFor={id} className="text-sm">
                {t(`field.${row.key}.label`)}
              </Label>
              <p className="text-xs text-muted-foreground">{t(`field.${row.key}.description`)}</p>
            </div>
          </div>
        )
      })}

      {TTLS.map((key) => {
        const id = `${idPrefix}-${key}`
        const current = value[key]
        // A ceiling set elsewhere (another client, the API) that is not one of
        // the presets is still offered, so the select never misstates it.
        const options = FILE_SHARING_TTL_PRESETS_SECONDS.includes(current)
          ? FILE_SHARING_TTL_PRESETS_SECONDS
          : [...FILE_SHARING_TTL_PRESETS_SECONDS, current].sort((a, b) => a - b)
        return (
          <div key={key} className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={id} className="text-sm">
              {t(`field.${key}.label`)}
            </Label>
            <Select
              value={String(current)}
              disabled={disabled}
              onValueChange={(next) =>
                onChange(editFileSharingPolicy(value, { [key]: Number(next) }))
              }
            >
              <SelectTrigger id={id} className="w-40" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {duration(seconds)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
