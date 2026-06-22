"use client"

// Reusable provider:model picker for the routing alias editor. Same option
// universe as the agent-runtime default-model picker (shared source in
// `lib/ai/routing/model-option-source.ts`).

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command>
          <CommandInput placeholder={t("entryPickerSearch")} />
          <CommandList>
            {groups.length === 0 ? (
              <CommandEmpty>{t("entryPickerEmpty")}</CommandEmpty>
            ) : (
              groups.map((group, idx) => (
                <div key={group.providerId}>
                  {idx > 0 ? <CommandSeparator /> : null}
                  <CommandGroup heading={group.providerName}>
                    {group.models.map((m) => {
                      const isActive = m === modelId && group.providerId === providerId
                      return (
                        <CommandItem
                          key={`${group.providerId}:${m}`}
                          value={`${group.providerId} ${m}`}
                          onSelect={() => {
                            setOpen(false)
                            onSelect(group.providerId, m)
                          }}
                        >
                          <CheckIcon
                            className={cn("mr-2 size-4", isActive ? "opacity-100" : "opacity-0")}
                          />
                          <span className="font-mono text-xs">{m}</span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </div>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default ProviderModelCombobox
