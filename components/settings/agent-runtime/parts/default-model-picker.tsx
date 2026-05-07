"use client"

// Default-model picker for the Built-in Agent Runtime settings page.
//
// Reads the same provider whitelist as `composer/model-picker.tsx` but
// persists the selection to `AppSettings.defaultModel` + `defaultProvider`
// instead of a session row. Used as the body of the "Default model" card
// in the Defaults tab.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ChevronsUpDownIcon, CpuIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { UserProviderSettings, CustomProviderSettings } from "@/types/provider/provider"

interface ModelOption {
  providerId: string
  providerName: string
  modelId: string
}

function collectOptions(
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined
): ModelOption[] {
  const out: ModelOption[] = []
  for (const [providerId, settings] of Object.entries(providerSettings ?? {})) {
    if (settings.enabled === false) continue
    const allowed = new Set<string>(settings.enabledModels ?? [])
    if (settings.defaultModel) allowed.add(settings.defaultModel)
    for (const m of settings.discoveredModels ?? []) {
      if (m?.id) allowed.add(m.id)
    }
    if (allowed.size === 0 && settings.defaultModel) allowed.add(settings.defaultModel)
    for (const modelId of allowed) {
      out.push({ providerId, providerName: providerId, modelId })
    }
  }
  for (const cp of customProviders ?? []) {
    if (cp.enabled === false) continue
    const ids = new Set<string>()
    if (cp.defaultModel) ids.add(cp.defaultModel)
    for (const m of cp.models ?? []) {
      const mid = (m as { id?: string }).id
      if (mid) ids.add(mid)
    }
    for (const modelId of ids) {
      out.push({ providerId: cp.id, providerName: cp.name ?? cp.id, modelId })
    }
  }
  return out
}

function groupByProvider(options: ModelOption[]) {
  const groups = new Map<string, { providerName: string; models: string[] }>()
  for (const opt of options) {
    const existing = groups.get(opt.providerId)
    if (existing) {
      if (!existing.models.includes(opt.modelId)) existing.models.push(opt.modelId)
    } else {
      groups.set(opt.providerId, { providerName: opt.providerName, models: [opt.modelId] })
    }
  }
  return Array.from(groups.entries()).map(([providerId, v]) => ({
    providerId,
    providerName: v.providerName,
    models: v.models,
  }))
}

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
  const buttonLabel = activeModel ? activeModel : t("modelUnset")

  const handleSelect = (providerId: string, modelId: string) => {
    setOpen(false)
    void save({ defaultModel: modelId, defaultProvider: providerId })
  }

  const handleClear = () => {
    setOpen(false)
    void save({ defaultModel: undefined, defaultProvider: undefined })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between gap-2 font-mono text-xs"
          aria-label={t("modelLabel")}
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">{buttonLabel}</span>
          </span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command>
          <CommandInput placeholder={t("modelSearch")} />
          <CommandList>
            {groups.length === 0 ? (
              <CommandEmpty>{t("modelEmpty")}</CommandEmpty>
            ) : (
              <>
                {groups.map((group, idx) => (
                  <div key={group.providerId}>
                    {idx > 0 ? <CommandSeparator /> : null}
                    <CommandGroup heading={group.providerName}>
                      {group.models.map((modelId) => {
                        const isActive =
                          modelId === activeModel && group.providerId === activeProvider
                        return (
                          <CommandItem
                            key={`${group.providerId}:${modelId}`}
                            value={`${group.providerId} ${modelId}`}
                            onSelect={() => handleSelect(group.providerId, modelId)}
                          >
                            <CheckIcon
                              className={cn("mr-2 size-4", isActive ? "opacity-100" : "opacity-0")}
                            />
                            <span className="font-mono text-xs">{modelId}</span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </div>
                ))}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="__clear__" onSelect={handleClear} disabled={!activeModel}>
                    <span className="text-xs text-muted-foreground">{t("modelClear")}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Exported for tests.
export const __testing__ = { collectOptions, groupByProvider }
