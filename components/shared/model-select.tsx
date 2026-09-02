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
// view once per open" behaviour.
//
// The row is a two-column read, not a left-indented list: identity (name over
// the raw id) on the left, and everything that describes the model — context
// window, capability glyphs, and the active tick — right-aligned against the
// opposite edge. The tick used to lead every row through a 32px gutter that
// 99% of rows spent empty, which pushed every name away from the left edge
// while the right half of a 360px popover stayed blank. Reserving the tick's
// box (opacity, not conditional mounting) keeps the meta column from stepping
// sideways on the one row that owns it.
//
// The `chat.composer.modelPicker` namespace stays as-is: the strings describe a
// model picker, not a chat, and re-keying them would fork the catalog for no
// gain.
//
// The frame around all of that is `ResponsivePicker`, not a hand-rolled Popover.
// Two things follow. On a phone this is a bottom sheet rather than an anchored
// panel opening into the keyboard, and the panel now carries the overlay
// surface tier, so a style pack's elevation ceiling reaches it like it reaches
// every other container. The list below is untouched cmdk either way.

import { useCallback, useMemo, useRef, useState } from "react"
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
import type { PopoverContent } from "@/components/ui/popover"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
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
  /**
   * Groups rendered ABOVE the configured providers, in the order given.
   *
   * The one caller today is an external agent: when a conversation runs on
   * Codex, Pi or Claude Code, that agent's own models are the ones the turn
   * will actually use, so they lead. The provider groups stay underneath
   * because a model configured in Cognia is still a legitimate choice for an
   * agent that accepts one. Selection reports the group's own `providerId`,
   * which is how the caller tells the two apart.
   */
  leadingGroups?: ModelProviderGroup[]
  /**
   * One line above the groups, for a caller that has something to explain
   * about why its leading group is missing or empty.
   *
   * An external agent contributes its own models, and when it contributes none
   * there are several different reasons: not connected, connected with nothing
   * open, or asked and unable to say. Rendering only the provider list in every
   * one of those cases tells the user their choice of agent did nothing.
   */
  leadingNotice?: React.ReactNode
  /**
   * Fired as the popover opens, before the list is drawn.
   *
   * For a caller whose leading group is fetched rather than configured. An
   * external agent's models cannot be read until the agent has a session open,
   * and it opens one on the first turn, with nothing in any store to say so.
   * Re-asking here is what stops a picker opened before that turn from
   * reporting "nothing open" for the rest of the conversation.
   */
  onOpen?: () => void
  /** Whether auto-routing is enabled app-wide; drives the Auto row's hint copy. */
  autoEnabled?: boolean
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
  leadingGroups,
  leadingNotice,
  onOpen,
  autoEnabled = false,
  disabled,
  className,
  align = "center",
  side = "top",
}: ModelSelectProps) {
  const t = useTranslations("chat.composer.modelPicker")
  const { options, groups: providerGroups } = useModelOptions()
  const groups = useMemo(
    () => (leadingGroups?.length ? [...leadingGroups, ...providerGroups] : providerGroups),
    [leadingGroups, providerGroups]
  )
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
    if (nextOpen) {
      positionedActiveModelRef.current = false
      onOpen?.()
    }
    setOpen(nextOpen)
  }

  const activeModelName = useMemo(() => {
    if (autoActive) return t("autoModel")
    const leading = leadingGroups
      ?.find((group) => group.providerId === provider)
      ?.models.find((candidate) => candidate.id === model)
    if (leading) return leading.name
    return resolveOptionModelName(options, model, provider)
  }, [options, leadingGroups, model, provider, autoActive, t])

  return (
    <ResponsivePicker
      open={open}
      onOpenChange={handleOpenChange}
      title={t("title")}
      align={align}
      side={side}
      testId="model-select-panel"
      trigger={
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
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      }
    >
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
                className="mx-1 gap-2.5 rounded-lg px-2.5 py-2"
              >
                <BrainIcon className="size-4 shrink-0 text-primary" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn("text-xs leading-none", autoActive && "font-medium")}>
                    {t("autoModel")}
                  </span>
                  <span className="truncate text-[10px] leading-tight text-muted-foreground">
                    {autoEnabled ? t("autoToggleHint") : t("autoEnableHint")}
                  </span>
                </span>
                <CheckIcon
                  className={cn(
                    "size-3.5 shrink-0 text-primary",
                    autoActive ? "opacity-100" : "opacity-0"
                  )}
                />
              </ModelSelectorItem>
            </ModelSelectorGroup>
            <ModelSelectorSeparator />
          </>
        ) : null}
        {leadingNotice ? (
          <p className="px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            {leadingNotice}
          </p>
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
                      className="mx-1 gap-2.5 rounded-lg px-2.5 py-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          className={cn(
                            "truncate text-xs leading-none",
                            isActive && "font-medium text-foreground"
                          )}
                        >
                          {modelName}
                        </span>
                        {modelName !== modelId ? (
                          <span className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
                            {modelId}
                          </span>
                        ) : null}
                      </span>
                      {/* Metadata reads as one right-aligned cluster: the
                              context window, then the capability glyphs in a
                              fixed order so the same capability sits in the
                              same place on every row. */}
                      {hasMeta ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
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
                      <CheckIcon
                        className={cn(
                          "size-3.5 shrink-0 text-primary",
                          isActive ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </ModelSelectorItem>
                  )
                })}
              </ModelSelectorGroup>
            </div>
          ))
        )}
      </ModelSelectorList>
    </ResponsivePicker>
  )
}
