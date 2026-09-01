"use client"

// Default-model picker for the Built-in Agent Runtime settings page.
//
// Persists to `AppSettings.defaultModel` + `defaultProvider` rather than to a
// session row. Used as the body of the "Default model" card in the Defaults
// tab.
//
// The list itself is `ProviderModelList`, shared with the goal judge picker and
// the routing alias combobox, which were three copies of the same forty lines.
// The frame is `ResponsivePicker`, so this becomes a bottom sheet on a phone
// and carries the overlay surface tier like every other picker.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, CpuIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"

export function DefaultModelPicker() {
  const t = useTranslations("settings.agentRuntimeSection.defaults")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const save = useSettingsStore((s) => s.save)

  const [open, setOpen] = useState(false)

  const options = useMemo(
    () => collectOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])

  const activeModel = defaultModel ?? ""
  const activeProvider = defaultProvider ?? ""

  return (
    <ResponsivePicker
      open={open}
      onOpenChange={setOpen}
      title={t("modelLabel")}
      align="start"
      side="bottom"
      contentClassName="w-[340px]"
      testId="default-model-panel"
      trigger={
        <Button
          variant="outline"
          className="w-full justify-between gap-2 font-mono text-xs"
          aria-label={t("modelLabel")}
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">{activeModel ? activeModel : t("modelUnset")}</span>
          </span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      }
    >
      <ProviderModelList
        groups={groups}
        activeProviderId={activeProvider}
        activeModelId={activeModel}
        searchPlaceholder={t("modelSearch")}
        emptyLabel={t("modelEmpty")}
        onSelect={(providerId, modelId) => {
          setOpen(false)
          void save({ defaultModel: modelId, defaultProvider: providerId })
        }}
        footer={{
          label: t("modelClear"),
          value: "__clear__",
          disabled: !activeModel,
          onSelect: () => {
            setOpen(false)
            void save({ defaultModel: undefined, defaultProvider: undefined })
          },
        }}
      />
    </ResponsivePicker>
  )
}

// Exported for tests.
export const __testing__ = { collectOptions, groupByProvider }
