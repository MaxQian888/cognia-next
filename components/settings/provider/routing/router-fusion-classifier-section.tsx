"use client"

// The LLM classifier's settings (ADR-0188 D18, B5), inside the Router + Fusion
// section. Off by default: Auto requests are labelled by the rules classifier.
// On, an Auto chat turn or Run API request costs one small ledgered call to the
// router model picked here, and falls back to the rules on a timeout, an
// unusable answer, a PII hit or a fault. The first enable carries the
// difficulty judge's settings over (`classifier-migration.ts`).

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { RouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import {
  carriedFromJudge,
  disableLlmClassifier,
  enableLlmClassifier,
} from "@/lib/router-fusion/settings/classifier-migration"
import { useSettingsStore } from "@/stores/settings"

import { ProviderModelCombobox } from "./provider-model-combobox"

type Persist = (
  patch:
    | Partial<RouterFusionSettings>
    | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)
) => void

export interface RouterFusionClassifierSectionProps {
  settings: RouterFusionSettings
  persist: Persist
}

interface IntegerFieldProps {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}

/** A whole number, validated on every keystroke and saved on blur only when it is in range. */
function IntegerField({ id, label, description, value, min, max, onCommit }: IntegerFieldProps) {
  const t = useTranslations("routerFusionClassifier.settings")
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(value)
  const parse = (text: string): number | null => {
    const trimmed = text.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const next = Number(trimmed)
    return Number.isSafeInteger(next) && next >= min && next <= max ? next : null
  }
  const invalid = draft !== null && parse(draft) === null
  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        value={shown}
        aria-invalid={invalid}
        aria-describedby={`${id}-desc`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === null) return
          const next = parse(draft)
          if (next === null) return
          setDraft(null)
          if (next !== value) onCommit(next)
        }}
        className="h-8 w-32 text-xs"
      />
      <p
        id={`${id}-desc`}
        className={invalid ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}
      >
        {invalid ? t("invalidNumber", { min, max }) : description}
      </p>
    </div>
  )
}

export function RouterFusionClassifierSection({
  settings,
  persist,
}: RouterFusionClassifierSectionProps) {
  const t = useTranslations("routerFusionClassifier.settings")
  const format = useFormatter()
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const classifier = settings.llmClassifier
  const hasModel = Boolean(classifier.routerProviderId && classifier.routerModelId)
  const carried = carriedFromJudge(settings)

  const setEnabled = (on: boolean) =>
    persist((current) =>
      on ? enableLlmClassifier(current, autoRouting, Date.now()) : disableLlmClassifier(current)
    )
  const patchClassifier = (patch: Partial<RouterFusionSettings["llmClassifier"]>) =>
    persist((current) => ({ llmClassifier: { ...current.llmClassifier, ...patch } }))

  return (
    <section
      className="space-y-3 rounded-lg border px-3 py-3"
      aria-labelledby="router-fusion-classifier-title"
      data-testid="router-fusion-classifier"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h4 id="router-fusion-classifier-title" className="text-xs font-medium">
            {t("title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("desc")}</p>
          {settings.enabled ? null : (
            <p className="text-[11px] text-muted-foreground">{t("needsMaster")}</p>
          )}
        </div>
        <Switch
          id="router-fusion-classifier-switch"
          checked={classifier.enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enable")}
        />
      </div>

      <div className="space-y-1 rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
        <p data-testid="router-fusion-classifier-cost">{t("costNote")}</p>
        <p>{t("fallbackNote")}</p>
      </div>

      {carried.length > 0 ? (
        <p className="text-[11px]" data-testid="router-fusion-classifier-migrated">
          {t("migrated", {
            fields: format.list(
              carried.map((field) => t(`migratedField.${field}` as never)),
              { type: "conjunction" }
            ),
          })}
        </p>
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="text-xs">{t("model")}</legend>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ProviderModelCombobox
              {...(classifier.routerProviderId ? { providerId: classifier.routerProviderId } : {})}
              {...(classifier.routerModelId ? { modelId: classifier.routerModelId } : {})}
              onSelect={(providerId, modelId) =>
                patchClassifier({ routerProviderId: providerId, routerModelId: modelId })
              }
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={!hasModel}
            onClick={() =>
              persist((current) => {
                const {
                  routerProviderId: _provider,
                  routerModelId: _model,
                  ...rest
                } = current.llmClassifier
                return { llmClassifier: rest }
              })
            }
          >
            {t("modelClear")}
          </Button>
        </div>
        <p
          className={
            classifier.enabled && !hasModel
              ? "text-[11px] text-amber-700 dark:text-amber-400"
              : "text-[11px] text-muted-foreground"
          }
          data-testid="router-fusion-classifier-model-hint"
        >
          {classifier.enabled && !hasModel ? t("modelUnset") : t("modelDesc")}
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <IntegerField
          id="router-fusion-classifier-timeout"
          label={t("timeout")}
          description={t("timeoutDesc")}
          value={classifier.timeoutMs}
          min={100}
          max={60_000}
          onCommit={(timeoutMs) => patchClassifier({ timeoutMs })}
        />
        <IntegerField
          id="router-fusion-classifier-ttl"
          label={t("cacheTtl")}
          description={t("cacheTtlDesc")}
          value={classifier.cacheTtlSeconds}
          min={0}
          max={86_400}
          onCommit={(cacheTtlSeconds) => patchClassifier({ cacheTtlSeconds })}
        />
      </div>
    </section>
  )
}

export default RouterFusionClassifierSection
