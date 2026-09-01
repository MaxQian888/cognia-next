"use client"

// Reusable provider:model picker for the routing alias editor.
//
// Same option universe as the agent-runtime default-model picker, and now the
// same list body too (`ProviderModelList`). The universe is the ROUTER's
// candidate set, which is the reason this does not use the chat composer's
// model picker: see the note in `provider-model-list.tsx`.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, CpuIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"

interface ProviderModelComboboxProps {
  providerId?: string
  modelId?: string
  onSelect: (providerId: string, modelId: string) => void
  className?: string
}

export function ProviderModelCombobox({
  providerId,
  modelId,
  onSelect,
  className,
}: ProviderModelComboboxProps) {
  const t = useTranslations("providers.routingView")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const [open, setOpen] = useState(false)

  const groups = useMemo(
    () => groupByProvider(collectOptions(providerSettings, customProviders)),
    [providerSettings, customProviders]
  )

  const buttonLabel =
    providerId && modelId ? `${providerId} / ${modelId}` : t("entryPickerPlaceholder")

  return (
    <ResponsivePicker
      open={open}
      onOpenChange={setOpen}
      title={t("entryPickerLabel")}
      align="start"
      side="bottom"
      contentClassName="w-[340px]"
      testId="routing-model-panel"
      trigger={
        <Button
          variant="outline"
          size="sm"
          className={cn("w-full justify-between gap-2 font-mono text-xs", className)}
          aria-label={t("entryPickerLabel")}
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">{buttonLabel}</span>
          </span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      }
    >
      <ProviderModelList
        groups={groups}
        {...(providerId === undefined ? {} : { activeProviderId: providerId })}
        {...(modelId === undefined ? {} : { activeModelId: modelId })}
        searchPlaceholder={t("entryPickerSearch")}
        emptyLabel={t("entryPickerEmpty")}
        onSelect={(nextProvider, nextModel) => {
          setOpen(false)
          onSelect(nextProvider, nextModel)
        }}
      />
    </ResponsivePicker>
  )
}

export default ProviderModelCombobox
