"use client"

// Controlled provider+model picker for the goal judge (Settings, Goals,
// Defaults).
//
// A CONTROLLED input: it reads and writes the caller's draft (`judgeModel` +
// `judgeProvider`) rather than persisting to settings itself. An empty
// selection inherits the chat model (the historical default). It replaced two
// free-text inputs so a typo can no longer silently downgrade the judge to the
// default provider. A stored value no configured provider offers is flagged
// inline instead.
//
// The list body is `ProviderModelList`, shared with the default-model picker
// and the routing alias combobox. Same option universe, same rows, one copy.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, ScaleIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"

export interface JudgeModelSelection {
  model?: string
  provider?: string
}

interface Props {
  model?: string
  provider?: string
  onChange: (next: JudgeModelSelection) => void
}

export function JudgeModelPicker({ model, provider, onChange }: Props) {
  const t = useTranslations("goal")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const [open, setOpen] = useState(false)

  const options = useMemo(
    () => collectOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])

  // A stored model that no configured provider offers would make
  // `buildGoalJudgeClient` return null and silently fall back to the chat
  // model. Surface it instead of downgrading in silence.
  const invalid = Boolean(
    model && !options.some((o) => o.modelId === model && (!provider || o.providerId === provider))
  )

  return (
    <div className="space-y-1">
      <ResponsivePicker
        open={open}
        onOpenChange={setOpen}
        title={t("judge.model")}
        align="start"
        side="bottom"
        contentClassName="w-[340px]"
        testId="goal-judge-model-panel"
        trigger={
          <Button
            variant="outline"
            className={cn(
              "w-full justify-between gap-2 font-mono text-xs",
              invalid && "border-destructive/60"
            )}
            aria-label={t("judge.model")}
            data-testid="goal-judge-model-picker"
          >
            <span className="flex items-center gap-2 truncate">
              <ScaleIcon className="size-3.5 shrink-0" />
              <span className="truncate">{model ? model : t("judge.useChatModel")}</span>
            </span>
            <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
          </Button>
        }
      >
        <ProviderModelList
          groups={groups}
          {...(provider === undefined ? {} : { activeProviderId: provider })}
          {...(model === undefined ? {} : { activeModelId: model })}
          searchPlaceholder={t("judge.searchPlaceholder")}
          emptyLabel={t("judge.noModels")}
          onSelect={(providerId, modelId) => {
            setOpen(false)
            onChange({ model: modelId, provider: providerId })
          }}
          footer={{
            label: t("judge.useChatModel"),
            value: "__inherit__",
            disabled: !model,
            onSelect: () => {
              setOpen(false)
              onChange({ model: undefined, provider: undefined })
            },
          }}
        />
      </ResponsivePicker>
      {invalid && (
        <p className="text-[10px] text-destructive" data-testid="goal-judge-model-invalid">
          {t("judge.invalidModel")}
        </p>
      )}
    </div>
  )
}
