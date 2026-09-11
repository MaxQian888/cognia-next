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
//
// That settings pair is dual-purpose, which this page has to know about. The
// composer writes an external agent's own model into it when a model is picked
// on a chat that has no row yet, stamped with the reserved provider marker (see
// `lib/ai/app-default-model.ts`). This card used to render that id verbatim as
// the SDK sidecar's default, which is how a page about the in-process Claude
// runtime came to show `commandcode/meta/muse-spark-1.3-contributor`: a model
// from an agent's vocabulary that no provider serves and that `resolveSendOptions`
// has always thrown away before the send. The trigger now shows what the sidecar
// will actually do (nothing is pinned) and the card says why, rather than hiding
// the row, because an unexplained empty default and a default the built-in lane
// is ignoring are two different situations for the user to act on.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, CpuIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { externalAgentAppDefault, resolveAppDefaultModel } from "@/lib/ai/app-default-model"
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

  // This card configures the built-in runtime, so it reads the pair on the
  // provider lane: an agent-owned default resolves to nothing here, exactly as
  // it does in `resolveSendOptions`.
  const agentOwned = externalAgentAppDefault({ defaultModel, defaultProvider })
  const lanePair = resolveAppDefaultModel({ defaultModel, defaultProvider })
  const activeModel = lanePair.model ?? ""
  const activeProvider = lanePair.provider ?? ""

  return (
    <div className="flex flex-col gap-2">
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
            // An agent-owned pair is clearable even though this lane reads no
            // model from it: it is a stale row the user can only reach here,
            // and disabling the row on `!activeModel` would strand it.
            label: agentOwned ? t("modelClearAgentOwned") : t("modelClear"),
            value: "__clear__",
            disabled: !activeModel && !agentOwned,
            onSelect: () => {
              setOpen(false)
              void save({ defaultModel: undefined, defaultProvider: undefined })
            },
          }}
        />
      </ResponsivePicker>
      {agentOwned ? (
        <p className="text-muted-foreground text-xs" data-testid="default-model-agent-owned">
          {agentOwned.agentId
            ? t("modelAgentOwned", { agent: agentOwned.agentId })
            : t("modelAgentOwnedUnnamed")}
        </p>
      ) : null}
    </div>
  )
}

// Exported for tests.
export const __testing__ = { collectOptions, groupByProvider }
