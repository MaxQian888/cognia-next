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
import {
  BrainIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  EyeIcon,
  WrenchIcon,
} from "lucide-react"

import { toast } from "sonner"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import { isTauri } from "@/lib/tauri"
import { setSessionModel, closeSession } from "@/lib/claude/ipc"
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
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"

interface ModelPickerProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

/** A model within a provider group: stable id + human-readable name + the
 * synchronously-known display metadata (context window + capability flags). */
interface GroupedModel {
  id: string
  name: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
}

/** Compact "128K" / "1M" context-window label. */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const v = tokens / 1_000_000
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/**
 * Group flat options by provider id; preserves insertion order of providers
 * (built-ins lead, custom trail) and models within each group. Each model
 * carries both its id (the value persisted on the session) and its display
 * name (what the user reads).
 */
function groupByProvider(options: ModelOption[]): Array<{
  providerId: string
  providerName: string
  models: GroupedModel[]
}> {
  const groups = new Map<string, { providerName: string; models: GroupedModel[] }>()
  const toGrouped = (opt: ModelOption): GroupedModel => ({
    id: opt.modelId,
    name: opt.modelName,
    contextLength: opt.contextLength,
    supportsTools: opt.supportsTools,
    supportsVision: opt.supportsVision,
    supportsReasoning: opt.supportsReasoning,
  })
  for (const opt of options) {
    const existing = groups.get(opt.providerId)
    if (existing) {
      if (!existing.models.some((m) => m.id === opt.modelId)) {
        existing.models.push(toGrouped(opt))
      }
    } else {
      groups.set(opt.providerId, {
        providerName: opt.providerName,
        models: [toGrouped(opt)],
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
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const saveSettings = useSettingsStore((s) => s.save)
  const autoEnabled = autoRouting?.enabled === true
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
  // Friendly label for the active model — prefer the matching option's display
  // name (provider-scoped), else any option with that id, else the raw id.
  const activeModelName = useMemo(() => {
    const exact = options.find((o) => o.modelId === activeModel && o.providerId === activeProvider)
    return (
      exact?.modelName ?? options.find((o) => o.modelId === activeModel)?.modelName ?? activeModel
    )
  }, [options, activeModel, activeProvider])

  const handleSelect = (providerId: string, modelId: string) => {
    setOpen(false)
    if (!session?.id) return
    const prevProvider = activeProvider
    setOptimisticModel(modelId)
    setOptimisticProvider(providerId)
    void updateSession(session.id, {
      model: modelId,
      providerOverride: providerId,
    })
    if (isTauri()) {
      if (providerId === prevProvider) {
        // Same provider, model-only change → live in-place switch driving the
        // running session's `setModel` so the next turn uses the new model
        // WITHOUT losing the conversation. Works on BOTH paths: the Anthropic
        // SDK `Query.setModel` and the ai-sdk multi-turn loop's `q.setModel`
        // (sidecar `handleControl` routes to whichever the live session
        // exposes). Best-effort — `no_active_session` (session not started yet)
        // is silent; the persisted override above covers that case.
        setSessionModel(session.id, modelId)
          .then(() => toast.success(t("liveSwitched", { model: modelId })))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes("no_active_session")) return
            toast.error(t("liveSwitchFailed"))
          })
      } else {
        // Provider change → the live session is on the wrong dispatch path
        // (Anthropic single-turn vs ai-sdk multi-turn), so an in-place model
        // swap can't apply. Close it so the next send re-dispatches on the new
        // provider; the persisted override above selects the new model/provider.
        // Best-effort — a not-yet-started session has nothing to close.
        void closeSession(session.id).catch(() => undefined)
      }
    }
  }

  const toggleAuto = (checked: boolean) => {
    void saveSettings({
      autoRouting: { ...(autoRouting ?? DEFAULT_AUTO_ROUTING), enabled: checked },
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
        <span className="min-w-0 truncate" title={activeModel}>
          {activeModelName}
        </span>
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
          {autoEnabled ? (
            <span
              className="shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] font-medium text-primary"
              title={t("autoBadgeHint")}
            >
              {t("autoBadge")}
            </span>
          ) : null}
          <span className="min-w-0 truncate" title={activeModel}>
            {activeModelName}
          </span>
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 flex-col">
            <Label htmlFor="composer-auto-routing" className="text-xs">
              {t("autoToggle")}
            </Label>
            <span className="truncate text-[10px] text-muted-foreground">
              {t("autoToggleHint")}
            </span>
          </div>
          <Switch
            id="composer-auto-routing"
            checked={autoEnabled}
            onCheckedChange={(c) => toggleAuto(c === true)}
          />
        </div>
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
                    {group.models.map((gm) => {
                      const { id: modelId, name: modelName } = gm
                      const isActive =
                        modelId === activeModel && group.providerId === activeProvider
                      const hasMeta =
                        gm.contextLength !== undefined ||
                        gm.supportsTools ||
                        gm.supportsVision ||
                        gm.supportsReasoning
                      return (
                        <CommandItem
                          key={`${group.providerId}:${modelId}`}
                          // Include both name and id so the command filter matches
                          // either the friendly name or the raw id the user types.
                          value={`${group.providerId} ${modelName} ${modelId}`}
                          onSelect={() => handleSelect(group.providerId, modelId)}
                        >
                          <CheckIcon
                            className={cn(
                              "mr-2 size-4 shrink-0",
                              isActive ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-xs">{modelName}</span>
                            {modelName !== modelId ? (
                              <span className="truncate font-mono text-[10px] text-muted-foreground">
                                {modelId}
                              </span>
                            ) : null}
                            {hasMeta ? (
                              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                {gm.contextLength !== undefined ? (
                                  <span title={t("contextWindowLabel")}>
                                    {formatContextWindow(gm.contextLength)}
                                  </span>
                                ) : null}
                                {gm.supportsTools ? (
                                  <WrenchIcon className="size-3" aria-label={t("capTools")} />
                                ) : null}
                                {gm.supportsVision ? (
                                  <EyeIcon className="size-3" aria-label={t("capVision")} />
                                ) : null}
                                {gm.supportsReasoning ? (
                                  <BrainIcon className="size-3" aria-label={t("capReasoning")} />
                                ) : null}
                              </span>
                            ) : null}
                          </span>
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
