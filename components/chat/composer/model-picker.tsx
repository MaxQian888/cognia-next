"use client"

// Composer model picker — small popover next to the model display in
// `bottom-toolbar.tsx` that lets the user switch the active provider /
// model on the current session without leaving the chat. Persists to the
// `ChatSession` row via `lib/db/sessions.ts:updateSession`.
//
// Mirrors the data shape Cognia uses in
// `D:\Project\Cognia\components\chat\dialogs\model-picker-dialog.tsx`,
// but renders inline (Popover + Command) instead of as a full dialog.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ChevronsUpDownIcon, CpuIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import type { ChatSession } from "@/lib/claude/types"
import { collectModelOptions, type ModelOption } from "@/lib/ai/model-options"
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

interface ModelPickerProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

/**
 * Group flat options by provider id; preserves insertion order of providers
 * (built-ins lead, custom trail) and models within each group.
 */
function groupByProvider(options: ModelOption[]): Array<{
  providerId: string
  providerName: string
  models: string[]
}> {
  const groups = new Map<string, { providerName: string; models: string[] }>()
  for (const opt of options) {
    const existing = groups.get(opt.providerId)
    if (existing) {
      if (!existing.models.includes(opt.modelId)) existing.models.push(opt.modelId)
    } else {
      groups.set(opt.providerId, {
        providerName: opt.providerName,
        models: [opt.modelId],
      })
    }
  }
  return Array.from(groups.entries()).map(([providerId, v]) => ({
    providerId,
    providerName: v.providerName,
    models: v.models,
  }))
}

export function ModelPicker({ session, disabled, className }: ModelPickerProps) {
  const t = useTranslations("chat.composer.modelPicker")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const [open, setOpen] = useState(false)
  // Optimistic state so the button label reflects the user's selection
  // immediately, before the parent re-renders with the updated session prop.
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null)
  const [optimisticProvider, setOptimisticProvider] = useState<string | null>(null)
  // Reset the optimistic overlay when the session id changes (render-time setState).
  const [prevSessionId, setPrevSessionId] = useState(session?.id)
  if (prevSessionId !== session?.id) {
    setPrevSessionId(session?.id)
    setOptimisticModel(null)
    setOptimisticProvider(null)
  }

  const options = useMemo(
    () => collectModelOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])

  const activeModel = optimisticModel ?? session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const activeProvider =
    optimisticProvider ?? session?.providerOverride ?? defaultProvider ?? "anthropic"

  const handleSelect = (providerId: string, modelId: string) => {
    setOpen(false)
    if (!session?.id) return
    setOptimisticModel(modelId)
    setOptimisticProvider(providerId)
    void updateSession(session.id, {
      model: modelId,
      providerOverride: providerId,
    })
  }

  // No session yet (composer rendered between sessions) — render a static
  // chip so layout doesn't shift.
  if (!session) {
    return (
      <span
        className={cn(
          // min-w-0 + max-w-full: as a flex item in the (wrapping) toolbar row
          // the chip must shrink below its content size so the long font-mono
          // model id truncates instead of overflowing a narrow sidebar.
          "flex min-w-0 max-w-full items-center gap-1.5 truncate text-[11px] text-muted-foreground",
          className
        )}
      >
        <CpuIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono">{activeModel}</span>
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            // Same shrink-to-fit treatment as the static chip above — long
            // model ids must ellipsize inside narrow composer containers.
            "h-6 min-w-0 max-w-full gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground",
            className
          )}
          aria-label={t("switchModelAria")}
        >
          <CpuIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{activeModel}</span>
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder={t("searchPlaceholder")} />
          <CommandList>
            {groups.length === 0 ? (
              <CommandEmpty>{t("noProviders")}</CommandEmpty>
            ) : (
              groups.map((group, idx) => (
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
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Exported for tests so the pure helpers can be exercised without rendering.
export const __testing__ = { collectModelOptions, groupByProvider }
