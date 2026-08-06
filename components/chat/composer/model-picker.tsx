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
import type { ChatSession } from "@cognia/agent-config-types"
import { collectModelOptions, type ModelOption } from "@/lib/ai/model-options"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import { resolveThinkingLevel } from "@/lib/ai/thinking-level"
import { EffortSelector } from "./effort-selector"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
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
  const tEffortLevels = useTranslations("settings.general")
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
  const autoActive = activeModel === "auto"
  // Friendly label for the active model — prefer the matching option's display
  // name (provider-scoped), else any option with that id, else the raw id.
  const activeModelName = useMemo(() => {
    if (autoActive) return t("autoModel")
    const exact = options.find((o) => o.modelId === activeModel && o.providerId === activeProvider)
    return (
      exact?.modelName ?? options.find((o) => o.modelId === activeModel)?.modelName ?? activeModel
    )
  }, [options, activeModel, activeProvider, autoActive, t])

  // Only surfaced when the user has actually chosen a level AND the active
  // model honours it — an "Auto" suffix on every chip would be noise. Read the
  // TIER rather than `session.effort`: `ultracode` persists as `"xhigh"` effort,
  // so the raw field would label the chip with the wrong tier.
  const effortTier = resolveThinkingLevel(session)
  const effortLabel =
    effortTier !== "off" && modelSupportsEffort(activeProvider, activeModel)
      ? tEffortLevels(`effort.${effortTier}`)
      : null

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

  const handleSelectAuto = () => {
    setOpen(false)
    if (!session?.id) return
    void saveSettings({
      autoRouting: { ...(autoRouting ?? DEFAULT_AUTO_ROUTING), enabled: true },
    })
    setOptimisticModel("auto")
    setOptimisticProvider("")
    void updateSession(session.id, {
      model: "auto",
      providerOverride: undefined,
    })
    if (isTauri()) {
      void closeSession(session.id).catch(() => undefined)
    }
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
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            // Same shrink-to-fit treatment as the static chip above — long
            // model ids must ellipsize inside narrow composer containers.
            "h-7 min-w-0 max-w-full gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:border-border/70 hover:bg-muted/70 hover:text-foreground",
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
          <span className="min-w-0 truncate" title={activeModel}>
            {activeModelName}
          </span>
          {/* Effort rides on the model chip instead of a second one beside it:
              it is a qualifier of the model, meaningless on its own, and only
              shown once set to something other than the model's own default. */}
          {effortLabel ? (
            <span className="shrink-0 text-muted-foreground/80" data-testid="model-picker-effort">
              {t("effortSuffix", { effort: effortLabel })}
            </span>
          ) : null}
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        title={t("title")}
        className="w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-xl"
      >
        <ModelSelectorInput placeholder={t("searchPlaceholder")} />
        <ModelSelectorList>
          <ModelSelectorGroup heading={t("routingGroup")}>
            <ModelSelectorItem
              value={`auto ${t("autoModel")} ${t("autoToggleHint")}`}
              onSelect={handleSelectAuto}
              className="mx-1 rounded-lg"
            >
              <CheckIcon
                className={cn("mr-2 size-4 shrink-0", autoActive ? "opacity-100" : "opacity-0")}
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
          {groups.length === 0 ? (
            <ModelSelectorEmpty>{t("noProviders")}</ModelSelectorEmpty>
          ) : (
            groups.map((group, idx) => (
              <div key={group.providerId}>
                {idx > 0 ? <ModelSelectorSeparator /> : null}
                <ModelSelectorGroup heading={group.providerName}>
                  {group.models.map((gm) => {
                    const { id: modelId, name: modelName } = gm
                    const isActive = modelId === activeModel && group.providerId === activeProvider
                    const hasMeta =
                      gm.contextLength !== undefined ||
                      gm.supportsTools ||
                      gm.supportsVision ||
                      gm.supportsReasoning
                    return (
                      <ModelSelectorItem
                        key={`${group.providerId}:${modelId}`}
                        // Include both name and id so the command filter matches
                        // either the friendly name or the raw id the user types.
                        value={`${group.providerId} ${modelName} ${modelId}`}
                        onSelect={() => handleSelect(group.providerId, modelId)}
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
        {/* The thinking level lives here rather than as its own toolbar chip —
            it qualifies a model and is meaningless on its own. It self-gates to
            nothing on models that ignore effort, so this block simply does not
            appear for them, and picks its own slider/list presentation from
            `composerBehavior.effortSelectorMode`. */}
        <EffortSelector session={session} disabled={disabled} />
      </ModelSelectorContent>
    </ModelSelector>
  )
}

// Exported for tests so the pure helpers can be exercised without rendering.
export const __testing__ = { collectModelOptions, groupByProvider }
