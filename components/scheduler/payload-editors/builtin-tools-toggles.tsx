"use client"

/**
 * Per-task overrides for the five `BuiltinToolsConfig` toggles. The control
 * surfaces three states per row: "use default" (undefined), "force on", and
 * "force off". The executor shallow-merges this Partial<BuiltinToolsConfig>
 * over the resolved app-settings toggles.
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
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"

type ToggleKey = keyof BuiltinToolsConfig
const KEYS: ToggleKey[] = ["fileExtras", "git", "process", "environment", "shellAdvanced"]

const SENTINEL_DEFAULT = "__use_default__"
const SENTINEL_ON = "__on__"
const SENTINEL_OFF = "__off__"

function toSentinel(v: boolean | undefined): string {
  if (v === true) return SENTINEL_ON
  if (v === false) return SENTINEL_OFF
  return SENTINEL_DEFAULT
}

function fromSentinel(v: string): boolean | undefined {
  if (v === SENTINEL_ON) return true
  if (v === SENTINEL_OFF) return false
  return undefined
}

export interface BuiltinToolsTogglesProps {
  value: Partial<BuiltinToolsConfig> | undefined
  onChange: (next: Partial<BuiltinToolsConfig> | undefined) => void
  disabled?: boolean
  testId?: string
}

export function BuiltinToolsToggles({
  value,
  onChange,
  disabled,
  testId,
}: BuiltinToolsTogglesProps) {
  const t = useTranslations("scheduler")

  function setKey(key: ToggleKey, sentinel: string) {
    const next: Partial<BuiltinToolsConfig> = { ...(value ?? {}) }
    const decoded = fromSentinel(sentinel)
    if (decoded === undefined) {
      delete next[key]
    } else {
      next[key] = decoded
    }
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }

  return (
    <div className="space-y-3" data-testid={testId}>
      {KEYS.map((key) => (
        <div key={key} className="grid grid-cols-1 sm:grid-cols-[1fr,160px] gap-2 sm:items-center">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">{t(`builtinTools.labels.${key}`)}</Label>
            <p className="text-xs text-muted-foreground">{t(`builtinTools.help.${key}`)}</p>
          </div>
          <Select
            value={toSentinel(value?.[key])}
            onValueChange={(v) => setKey(key, v)}
            disabled={disabled}
          >
            <SelectTrigger className="h-9" data-testid={`${testId}-${key}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SENTINEL_DEFAULT}>{t("builtinTools.useDefault")}</SelectItem>
              <SelectItem value={SENTINEL_ON}>{t("builtinTools.forceOn")}</SelectItem>
              <SelectItem value={SENTINEL_OFF}>{t("builtinTools.forceOff")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  )
}
