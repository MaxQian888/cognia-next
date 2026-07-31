"use client"

// Controlled provider+model picker for the goal judge (Settings → Goals →
// Defaults). Reuses the shared option universe (`collectOptions` /
// `groupByProvider`) that backs the default-model picker, but is a CONTROLLED
// input: it reads/writes the caller's draft (`judgeModel` + `judgeProvider`)
// rather than persisting to settings itself. An empty selection inherits the
// chat model (the historical default). Replaces the two free-text <Input>s so
// a typo can no longer silently downgrade the judge to the default provider —
// a stored value no configured provider offers is flagged inline instead.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ChevronsUpDownIcon, ScaleIcon } from "lucide-react"

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

  const buttonLabel = model ? model : t("judge.useChatModel")

  const select = (providerId: string, modelId: string) => {
    setOpen(false)
    onChange({ model: modelId, provider: providerId })
  }
  const clear = () => {
    setOpen(false)
    onChange({ model: undefined, provider: undefined })
  }

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
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
              <span className="truncate">{buttonLabel}</span>
            </span>
            <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[340px] p-0">
          <Command>
            <CommandInput placeholder={t("judge.searchPlaceholder")} />
            <CommandList>
              {groups.length === 0 ? (
                <CommandEmpty>{t("judge.noModels")}</CommandEmpty>
              ) : (
                <>
                  {groups.map((group, idx) => (
                    <div key={group.providerId}>
                      {idx > 0 ? <CommandSeparator /> : null}
                      <CommandGroup heading={group.providerName}>
                        {group.models.map((modelId) => {
                          const isActive = modelId === model && group.providerId === provider
                          return (
                            <CommandItem
                              key={`${group.providerId}:${modelId}`}
                              value={`${group.providerId} ${modelId}`}
                              onSelect={() => select(group.providerId, modelId)}
                            >
                              <CheckIcon
                                className={cn(
                                  "mr-2 size-4",
                                  isActive ? "opacity-100" : "opacity-0"
                                )}
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
                    <CommandItem value="__inherit__" onSelect={clear} disabled={!model}>
                      <span className="text-xs text-muted-foreground">
                        {t("judge.useChatModel")}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {invalid && (
        <p className="text-[10px] text-destructive" data-testid="goal-judge-model-invalid">
          {t("judge.invalidModel")}
        </p>
      )}
    </div>
  )
}
