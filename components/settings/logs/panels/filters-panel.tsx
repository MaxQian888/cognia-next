"use client"

/**
 * Logs → Filtering & redaction.
 *
 * Everything that decides what survives between "the app called `log.info()`"
 * and "a transport sees the entry": how many of the noisy modules' lines are
 * kept, how hard the diagnostics are throttled, and what is scrubbed out of the
 * payload first. All three used to live in the `Advanced` tab, which was really
 * an "everything else" drawer.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FilterIcon, PlusIcon, ShieldIcon, SparklesIcon, Trash2Icon } from "lucide-react"

import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

import { CONFIG_BOUNDS } from "@/lib/logging"

import { SliderField } from "../components/slider-field"
import {
  RECOMMENDED_SAMPLING_RULES,
  type SamplingRule,
  type UseLogSettingsDraftResult,
} from "@/hooks/logging/use-log-settings-draft"

export interface LogsFiltersPanelProps {
  draft: UseLogSettingsDraftResult
}

export function LogsFiltersPanel({ draft }: LogsFiltersPanelProps) {
  const t = useTranslations("logging")
  const [newRule, setNewRule] = useState<SamplingRule>({ modulePrefix: "", percentage: 100 })

  const rules = useMemo(
    () =>
      [...draft.samplingRules].sort((left, right) =>
        left.modulePrefix.localeCompare(right.modulePrefix)
      ),
    [draft.samplingRules]
  )

  const redaction = draft.config.redaction
  const redactKeyCount = redaction?.redactKeys?.length ?? 0
  const redactPatternCount = redaction?.redactPatterns?.length ?? 0

  const upsertRule = (rule: SamplingRule) => {
    const prefix = rule.modulePrefix.trim()
    if (!prefix) return
    const existing = draft.samplingRules.find((entry) => entry.modulePrefix === prefix)
    draft.setSamplingRules(
      existing
        ? draft.samplingRules.map((entry) =>
            entry.modulePrefix === prefix ? { ...entry, percentage: rule.percentage } : entry
          )
        : [...draft.samplingRules, { modulePrefix: prefix, percentage: rule.percentage }]
    )
  }

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<ShieldIcon />}
        title={t("settings.advanced.redactionTitle")}
        description={t("settings.advanced.redactionDescription")}
        testid="logs-filters-redaction"
      >
        <SettingsField
          htmlFor="logs-redaction-enabled"
          label={t("settings.advanced.redactionEnabled")}
          description={t("settings.advanced.redactionEnabledDesc")}
        >
          <Switch
            id="logs-redaction-enabled"
            checked={Boolean(redaction?.enabled)}
            onCheckedChange={(checked) => draft.setRedaction("enabled", checked)}
          />
        </SettingsField>

        <SliderField
          id="logs-redaction-depth"
          label={t("settings.advanced.redactionDepth")}
          description={t("settings.advanced.redactionDepthDesc")}
          valueLabel={String(redaction?.maxDepth ?? 0)}
          value={redaction?.maxDepth ?? 0}
          min={CONFIG_BOUNDS.redactionMaxDepth.min}
          max={CONFIG_BOUNDS.redactionMaxDepth.max}
          disabled={!redaction?.enabled}
          onValueChange={(value) => draft.setRedaction("maxDepth", value)}
          testid="logs-redaction-depth-field"
        />

        <p className="text-xs text-muted-foreground">
          {t("settings.advanced.redactionRuleCount", {
            keys: redactKeyCount,
            patterns: redactPatternCount,
          })}
        </p>
      </SettingsBlock>

      <SettingsBlock
        icon={<FilterIcon />}
        title={t("settings.sampling.title")}
        description={t("settings.sampling.description")}
        testid="logs-filters-sampling"
        action={
          rules.length > 0 ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="logs-sampling-apply-preset"
              onClick={() => draft.setSamplingRules([...RECOMMENDED_SAMPLING_RULES])}
            >
              <SparklesIcon className="mr-1.5 size-3.5" />
              {t("settings.sampling.applyPreset")}
            </Button>
          )
        }
      >
        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="logs-sampling-empty">
            {t("settings.sampling.empty")}
          </p>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border">
            {rules.map((rule) => (
              <div
                key={rule.modulePrefix}
                className="space-y-2 px-3 py-3"
                data-testid={`logs-sampling-rule-${rule.modulePrefix}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {rule.modulePrefix}
                  </span>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
                    {rule.percentage}%
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={`${t("settings.sampling.removeRule")} ${rule.modulePrefix}`}
                    onClick={() =>
                      draft.setSamplingRules(
                        draft.samplingRules.filter(
                          (entry) => entry.modulePrefix !== rule.modulePrefix
                        )
                      )
                    }
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
                <SliderField
                  id={`logs-sampling-${rule.modulePrefix}`}
                  label={`${rule.modulePrefix} — ${t("settings.sampling.percentage")}`}
                  valueLabel={`${rule.percentage}%`}
                  value={rule.percentage}
                  min={0}
                  max={100}
                  onValueChange={(value) => upsertRule({ ...rule, percentage: value })}
                  hideLabel
                  className="border-b-0 pb-0"
                />
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="flex flex-col gap-2 @md/settings-stack:flex-row @md/settings-stack:items-end">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="logs-new-sampling-prefix" className="text-xs">
                {t("settings.sampling.modulePrefix")}
              </Label>
              <Input
                id="logs-new-sampling-prefix"
                value={newRule.modulePrefix}
                placeholder={t("settings.sampling.modulePrefixPlaceholder")}
                onChange={(event) =>
                  setNewRule((previous) => ({ ...previous, modulePrefix: event.target.value }))
                }
              />
            </div>
            <Button
              onClick={() => {
                upsertRule(newRule)
                setNewRule({ modulePrefix: "", percentage: 100 })
              }}
              disabled={!newRule.modulePrefix.trim()}
            >
              <PlusIcon className="mr-1 size-4" />
              {t("settings.sampling.addRule")}
            </Button>
          </div>
          <SliderField
            id="logs-new-sampling-percentage"
            label={t("settings.sampling.percentage")}
            valueLabel={`${newRule.percentage}%`}
            value={newRule.percentage}
            min={0}
            max={100}
            onValueChange={(value) =>
              setNewRule((previous) => ({ ...previous, percentage: value }))
            }
            className="border-b-0 pb-0"
          />
        </div>
      </SettingsBlock>

      <SettingsBlock
        title={t("settings.advanced.diagnosticTitle")}
        description={t("settings.advanced.diagnosticDescription")}
        testid="logs-filters-diagnostics"
      >
        <SliderField
          id="logs-diagnostic-rate-limit"
          label={t("settings.advanced.diagnosticRateLimit")}
          description={t("settings.advanced.diagnosticRateLimitDesc")}
          valueLabel={`${draft.config.diagnosticRateLimitMs} ms`}
          value={draft.config.diagnosticRateLimitMs}
          min={CONFIG_BOUNDS.diagnosticRateLimitMs.min}
          max={CONFIG_BOUNDS.diagnosticRateLimitMs.max}
          step={250}
          onValueChange={(value) => draft.setConfig("diagnosticRateLimitMs", value)}
        />
      </SettingsBlock>
    </SettingsStack>
  )
}
