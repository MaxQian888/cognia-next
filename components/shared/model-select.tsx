"use client"

// Controlled provider/model selector.
//
// This is the whole presentation and interaction of the composer's model
// picker, with the persistence removed: it takes the active `provider`/`model`
// and reports a choice, and knows nothing about chat sessions, Dexie, or the
// live-switch IPC. `components/chat/composer/model-picker.tsx` is the
// session-bound binding (it persists to the `ChatSession` row and drives
// `setSessionModel`); the A2UI hub composer is the ephemeral binding (it keeps
// the choice in an A2UI-local preference and folds it into the throwaway
// session handed to `resolveSendOptions`).
//
// Extracted rather than copied so the two surfaces can never drift on model
// grouping, capability glyphs, the Auto row, or the "scroll the active row into
// view once per open" behaviour. The markup is deliberately byte-identical to
// what the chat picker rendered before the split — its test suite asserts the
// trigger geometry, the popover anchoring and the positioning callback, and
// passes unchanged against this component.
//
// The `chat.composer.modelPicker` namespace stays as-is: the strings describe a
// model picker, not a chat, and re-keying them would fork the catalog for no
// gain.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BrainIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  EyeIcon,
  WrenchIcon,
} from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { collectModelOptions, type ModelOption } from "@/lib/ai/model-options"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Command } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
} from "@/components/ai-elements/model-selector"

/** A model within a provider group: stable id + human-readable name + the
 * synchronously-known display metadata (context window + capability flags). */
export interface GroupedModel {
  id: string
  name: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
}

export interface ModelProviderGroup {
  providerId: string
  providerName: string
  models: GroupedModel[]
}

export interface ModelSelectChoice {
  providerId: string
  modelId: string
}

export interface ModelSelectProps {
  /** Active model id. `"auto"` selects the routing row. */
  model: string
  /** Active provider id. */
  provider: string
  onSelect: (choice: ModelSelectChoice) => void
  /**
   * Handler for the Auto routing row. Omit to hide the row entirely — a surface
   * with no router (the A2UI generation turn resolves one concrete model) must
   * not offer a choice it cannot honour.
   */
  onSelectAuto?: () => void
  /** Whether auto-routing is enabled app-wide; drives the Auto row's hint copy. */
  autoEnabled?: boolean
  /** Rendered after the model name on the trigger. Chat shows the effort tier. */
  triggerSuffix?: ReactNode
  /** Rendered at the bottom of the popover. Chat mounts the effort selector. */
  footer?: ReactNode
  disabled?: boolean
  /** Applied to the trigger button. */
  className?: string
  align?: React.ComponentProps<typeof PopoverContent>["align"]
  side?: React.ComponentProps<typeof PopoverContent>["side"]
}

/**
 * The composer chip look shared by every control on a composer option row —
 * exported so sibling controls (the A2UI agent chip) sit on exactly the same
 * height, radius and hover treatment instead of re-deriving them.
 */
export const composerChipTriggerClass =
  "h-7 min-w-0 max-w-full gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:border-border/70 hover:bg-muted/70 hover:text-foreground"

/** Compact "128K" / "1M" context-window label. */
export function formatContextWindow(tokens: number): string {
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
export function groupByProvider(options: ModelOption[]): ModelProviderGroup[] {
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

/**
 * Every model the user has configured, grouped by provider. Shared by the
 * selector and by callers that need the same list to resolve a display name.
 */
export function useModelOptions(): { options: ModelOption[]; groups: ModelProviderGroup[] } {
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const options = useMemo(
    () => collectModelOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
  const groups = useMemo(() => groupByProvider(options), [options])
  return { options, groups }
}

/**
 * Friendly label for a model id: prefer the option matching BOTH provider and
 * model, then any option with that id (a provider switch leaves the id valid
 * but re-homed), then the raw id.
 */
export function resolveOptionModelName(
  options: ModelOption[],
  model: string,
  provider: string
): string {
  const exact = options.find((o) => o.modelId === model && o.providerId === provider)
  return exact?.modelName ?? options.find((o) => o.modelId === model)?.modelName ?? model
}

export function ModelSelect({
  model,
  provider,
  onSelect,
  onSelectAuto,
  autoEnabled = false,
  triggerSuffix,
  footer,
  disabled,
  className,
  align = "center",
  side = "top",
}: ModelSelectProps) {
  const t = useTranslations("chat.composer.modelPicker")
  const { options, groups } = useModelOptions()
  const [open, setOpen] = useState(false)
  const positionedActiveModelRef = useRef(false)

  const autoActive = model === "auto"

  // The popover content is mounted in a portal after the open state changes, so
  // position from the active item's ref callback instead of an opening effect.
  // The callback stays stable while open and the guard prevents remounts or
  // user interaction from pulling the list back after the initial alignment.
  const positionActiveModelItem = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !open || positionedActiveModelRef.current) return
      positionedActiveModelRef.current = true
      node.scrollIntoView?.({ behavior: "auto", block: "center" })
    },
    [open]
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) positionedActiveModelRef.current = false
    setOpen(nextOpen)
  }

  const activeModelName = useMemo(() => {
    if (autoActive) return t("autoModel")
    return resolveOptionModelName(options, model, provider)
  }, [options, model, provider, autoActive, t])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            // Shrink-to-fit: long model ids must ellipsize inside narrow
            // composer containers instead of overflowing the row.
            composerChipTriggerClass,
            className
          )}
          aria-label={t("switchModelAria")}
        >
          <CpuIcon className="size-3.5 shrink-0" />
          {autoActive ? (
            <span
              className="shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] font-medium text-primary"
              title={t("autoBadgeHint")}
            >
              {t("autoBadge")}
            </span>
          ) : null}
          <span className="min-w-0 truncate" title={model}>
            {activeModelName}
          </span>
          {triggerSuffix}
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={8}
        aria-label={t("title")}
        className="w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-xl"
      >
        <Command className="**:data-[slot=command-input-wrapper]:h-auto">
          <ModelSelectorInput placeholder={t("searchPlaceholder")} />
          <ModelSelectorList>
            {onSelectAuto ? (
              <>
                <ModelSelectorGroup heading={t("routingGroup")}>
                  <ModelSelectorItem
                    ref={autoActive ? positionActiveModelItem : undefined}
                    value={`auto ${t("autoModel")} ${t("autoToggleHint")}`}
                    onSelect={() => {
                      setOpen(false)
                      onSelectAuto()
                    }}
                    className="mx-1 rounded-lg"
                  >
                    <CheckIcon
                      className={cn(
                        "mr-2 size-4 shrink-0",
                        autoActive ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <BrainIcon className="mr-2 size-4 shrink-0 text-primary" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-xs">{t("autoModel")}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {autoEnabled ? t("autoToggleHint") : t("autoEnableHint")}
                      </span>
                    </span>
                  </ModelSelectorItem>
                </ModelSelectorGroup>
                <ModelSelectorSeparator />
              </>
            ) : null}
            {groups.length === 0 ? (
              <ModelSelectorEmpty>{t("noProviders")}</ModelSelectorEmpty>
            ) : (
              groups.map((group, idx) => (
                <div key={group.providerId}>
                  {idx > 0 ? <ModelSelectorSeparator /> : null}
                  <ModelSelectorGroup heading={group.providerName}>
                    {group.models.map((gm) => {
                      const { id: modelId, name: modelName } = gm
                      const isActive = modelId === model && group.providerId === provider
                      const hasMeta =
                        gm.contextLength !== undefined ||
                        gm.supportsTools ||
                        gm.supportsVision ||
                        gm.supportsReasoning
                      return (
                        <ModelSelectorItem
                          key={`${group.providerId}:${modelId}`}
                          ref={isActive ? positionActiveModelItem : undefined}
                          // Include both name and id so the command filter matches
                          // either the friendly name or the raw id the user types.
                          value={`${group.providerId} ${modelName} ${modelId}`}
                          onSelect={() => {
                            setOpen(false)
                            onSelect({ providerId: group.providerId, modelId })
                          }}
                          className="mx-1 rounded-lg"
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
                        </ModelSelectorItem>
                      )
                    })}
                  </ModelSelectorGroup>
                </div>
              ))
            )}
          </ModelSelectorList>
          {footer}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
