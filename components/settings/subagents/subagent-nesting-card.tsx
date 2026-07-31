"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { AppSettings } from "@cognia/agent-config-types"

const clampInt = (value: string, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Form values for the nested-dispatch policy. `timeoutSeconds` is the display
 * unit; the setting stores milliseconds.
 */
export interface NestingPolicyValues {
  enabled: boolean
  maxDepth: number
  tokenBudget: number
  timeoutSeconds: number
  dispatchMaxRetries: number
}

export const NESTING_DEFAULTS: NestingPolicyValues = {
  enabled: false,
  maxDepth: 2,
  tokenBudget: 0,
  timeoutSeconds: 0,
  dispatchMaxRetries: 1,
}

export function nestingValuesFromSettings(
  settings: AppSettings | null | undefined
): NestingPolicyValues {
  const cfg = settings?.subagentNesting
  if (!cfg) return NESTING_DEFAULTS
  return {
    enabled: cfg.enabled ?? NESTING_DEFAULTS.enabled,
    maxDepth: cfg.maxDepth ?? NESTING_DEFAULTS.maxDepth,
    tokenBudget: cfg.tokenBudget ?? NESTING_DEFAULTS.tokenBudget,
    timeoutSeconds: cfg.timeoutMs ? Math.round(cfg.timeoutMs / 1000) : 0,
    dispatchMaxRetries: cfg.dispatchMaxRetries ?? NESTING_DEFAULTS.dispatchMaxRetries,
  }
}

export function nestingValuesToSettings(
  values: NestingPolicyValues
): NonNullable<AppSettings["subagentNesting"]> {
  return {
    enabled: values.enabled,
    maxDepth: values.maxDepth,
    tokenBudget: values.tokenBudget > 0 ? values.tokenBudget : 0,
    timeoutMs: values.timeoutSeconds > 0 ? values.timeoutSeconds * 1000 : 0,
    dispatchMaxRetries: values.dispatchMaxRetries,
  }
}

export interface SubagentNestingCardProps {
  value: NestingPolicyValues
  onChange: (partial: Partial<NestingPolicyValues>) => void
}

/**
 * App-level config for nested subagent dispatch (depth-N). Opt-in: when off,
 * the chat agent keeps the SDK-native Task tool (depth 1) and nothing changes.
 *
 * Controlled. It used to own both its state and its own Save button, hydrating
 * from the settings store on every `settings` change — which meant a save
 * anywhere else in the app silently discarded whatever was being typed here.
 * The draft, the dirty set and the single save now live in the owning panel
 * (`use-policy-draft.ts`), so that class of loss is gone.
 */
export function SubagentNestingCard({ value, onChange }: SubagentNestingCardProps) {
  const t = useTranslations("settings.subagents.nesting")

  return (
    <div className="space-y-4" data-setting-id="subagent-nesting">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-subagent-nesting-enabled" className="text-sm">
            {t("enabled")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch
          id="settings-subagent-nesting-enabled"
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label={t("enabled")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-depth">{t("maxDepth")}</Label>
        <Input
          id="settings-subagent-nesting-depth"
          type="number"
          min={1}
          max={5}
          value={value.maxDepth}
          onChange={(e) => onChange({ maxDepth: clampInt(e.target.value, 1, 5, 2) })}
          disabled={!value.enabled}
          aria-label={t("maxDepth")}
        />
        <p className="text-xs text-muted-foreground">{t("maxDepthHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-budget">{t("tokenBudget")}</Label>
        <Input
          id="settings-subagent-nesting-budget"
          type="number"
          min={0}
          step={1000}
          value={value.tokenBudget}
          onChange={(e) => onChange({ tokenBudget: clampInt(e.target.value, 0, 100_000_000, 0) })}
          disabled={!value.enabled}
          aria-label={t("tokenBudget")}
        />
        <p className="text-xs text-muted-foreground">{t("tokenBudgetHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-timeout">{t("timeout")}</Label>
        <Input
          id="settings-subagent-nesting-timeout"
          type="number"
          min={0}
          step={10}
          value={value.timeoutSeconds}
          onChange={(e) => onChange({ timeoutSeconds: clampInt(e.target.value, 0, 86_400, 0) })}
          disabled={!value.enabled}
          aria-label={t("timeout")}
        />
        <p className="text-xs text-muted-foreground">{t("timeoutHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-dispatch-retries">{t("dispatchMaxRetries")}</Label>
        <Input
          id="settings-subagent-dispatch-retries"
          type="number"
          min={0}
          max={5}
          value={value.dispatchMaxRetries}
          onChange={(e) => onChange({ dispatchMaxRetries: clampInt(e.target.value, 0, 5, 1) })}
          aria-label={t("dispatchMaxRetries")}
        />
        <p className="text-xs text-muted-foreground">{t("dispatchMaxRetriesHint")}</p>
      </div>
    </div>
  )
}
