"use client"

/**
 * Controlled provider + model picker for one Harness Evolution role. An empty
 * selection means "the agent's own model". Built on the shared
 * `ProviderModelList` (the same rows the default-model and goal-judge pickers
 * draw), so the option universe is identical everywhere. A stored model no
 * configured provider offers is flagged instead of failing at run start.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, CpuIcon } from "lucide-react"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import type { HarnessRole, HarnessRoleModel } from "@/types/harness/evolution"

export interface HarnessRoleModelPickerProps {
  role: HarnessRole
  value: HarnessRoleModel | undefined
  onChange: (next: HarnessRoleModel | undefined) => void
}

export function HarnessRoleModelPicker({ role, value, onChange }: HarnessRoleModelPickerProps) {
  const t = useTranslations("harnessEvolution.settings")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const [open, setOpen] = useState(false)
  const options = useMemo(
    () => collectOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])
  const model = value?.model
  const provider = value?.providerId
  const invalid = Boolean(
    model && !options.some((o) => o.modelId === model && (!provider || o.providerId === provider))
  )
  const label = t(`role.${role}`)

  return (
    <div className="space-y-1">
      <ResponsivePicker
        open={open}
        onOpenChange={setOpen}
        title={label}
        align="end"
        side="bottom"
        contentClassName="w-[340px]"
        testId={`harness-role-model-panel-${role}`}
        trigger={
          <Button
            variant="outline"
            className={cn(
              "w-full justify-between gap-2 font-mono text-xs sm:w-[240px]",
              invalid && "border-destructive/60"
            )}
            aria-label={label}
            data-testid={`harness-role-model-${role}`}
          >
            <span className="flex items-center gap-2 truncate">
              <CpuIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{model ?? t("agentModel")}</span>
            </span>
            <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" aria-hidden />
          </Button>
        }
      >
        <ProviderModelList
          groups={groups}
          {...(provider === undefined ? {} : { activeProviderId: provider })}
          {...(model === undefined ? {} : { activeModelId: model })}
          searchPlaceholder={t("searchModels")}
          emptyLabel={t("noModels")}
          onSelect={(providerId, modelId) => {
            setOpen(false)
            onChange({ providerId, model: modelId })
          }}
          footer={{
            label: t("agentModel"),
            value: "__inherit__",
            disabled: !model,
            onSelect: () => {
              setOpen(false)
              onChange(undefined)
            },
          }}
        />
      </ResponsivePicker>
      {invalid ? (
        <p
          className="text-[10px] text-destructive"
          data-testid={`harness-role-model-invalid-${role}`}
        >
          {t("invalidModel")}
        </p>
      ) : null}
    </div>
  )
}
