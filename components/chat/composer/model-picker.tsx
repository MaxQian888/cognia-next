"use client"

// Composer model picker — the SESSION-BOUND binding of the shared
// `<ModelSelect>` control (`components/shared/model-select.tsx`).
//
// The control itself (trigger chip, provider groups, capability glyphs, Auto
// row, active-row positioning) lives in the shared component so the A2UI hub
// composer renders exactly the same picker without inheriting chat's
// persistence. What stays here is everything that is genuinely about a chat
// session: persisting to the `ChatSession` row via `lib/db/sessions.ts:
// updateSession`, the in-place `setModel` live switch, closing the runtime on a
// provider change, the optimistic label overlay, the effort qualifier on the
// trigger, and the static chip rendered between sessions.

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { CpuIcon } from "lucide-react"

import { toast } from "sonner"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import { isTauri } from "@/lib/tauri"
import { useOptionalChatScope } from "@/components/chat/chat-scope-provider"
import { setSessionModel, closeSession } from "@/lib/claude/ipc"
import type { ChatSession } from "@cognia/agent-config-types"
import { collectModelOptions } from "@/lib/ai/model-options"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import { resolveThinkingLevel } from "@/lib/ai/thinking-level"
import { EffortSelector } from "./effort-selector"
import { cn } from "@/lib/utils"
import {
  ModelSelect,
  groupByProvider,
  resolveOptionModelName,
  useModelOptions,
} from "@/components/shared/model-select"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"

interface ModelPickerProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

export function ModelPicker({ session, disabled, className }: ModelPickerProps) {
  const scope = useOptionalChatScope()
  const t = useTranslations("chat.composer.modelPicker")
  const tEffortLevels = useTranslations("settings.general")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const saveSettings = useSettingsStore((s) => s.save)
  const autoEnabled = autoRouting?.enabled === true
  const { options } = useModelOptions()
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

  const activeModel = optimisticModel ?? session?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
  const activeProvider =
    optimisticProvider ?? session?.providerOverride ?? defaultProvider ?? "anthropic"
  const autoActive = activeModel === "auto"

  // Only surfaced when the user has actually chosen a level AND the active
  // model honours it — an "Auto" suffix on every chip would be noise. Read the
  // TIER rather than `session.effort`: `ultracode` persists as `"xhigh"` effort,
  // so the raw field would label the chip with the wrong tier.
  const effortTier = resolveThinkingLevel(session)
  const effortLabel =
    effortTier !== "off" && modelSupportsEffort(activeProvider, activeModel)
      ? tEffortLevels(`effort.${effortTier}`)
      : null

  const handleSelect = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
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
        const liveSwitch =
          scope?.sessionId === session.id && scope.setModel
            ? scope.setModel(modelId)
            : setSessionModel(session.id, modelId)
        liveSwitch
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
        const reset =
          scope?.sessionId === session.id && scope.resetRuntime
            ? scope.resetRuntime()
            : closeSession(session.id)
        void reset.catch(() => undefined)
      }
    }
  }

  const handleSelectAuto = () => {
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
      const reset =
        scope?.sessionId === session.id && scope.resetRuntime
          ? scope.resetRuntime()
          : closeSession(session.id)
      void reset.catch(() => undefined)
    }
  }

  // No session yet (composer rendered between sessions) — render a static
  // chip so layout doesn't shift.
  if (!session) {
    const activeModelName = autoActive
      ? t("autoModel")
      : resolveOptionModelName(options, activeModel, activeProvider)
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
    <ModelSelect
      model={activeModel}
      provider={activeProvider}
      onSelect={handleSelect}
      onSelectAuto={handleSelectAuto}
      autoEnabled={autoEnabled}
      disabled={disabled}
      className={className}
      triggerSuffix={
        /* Effort rides on the model chip instead of a second one beside it:
           it is a qualifier of the model, meaningless on its own, and only
           shown once set to something other than the model's own default. */
        effortLabel ? (
          <span className="shrink-0 text-muted-foreground/80" data-testid="model-picker-effort">
            {t("effortSuffix", { effort: effortLabel })}
          </span>
        ) : null
      }
      footer={
        /* The thinking level lives here rather than as its own toolbar chip —
           it qualifies a model and is meaningless on its own. It self-gates to
           nothing on models that ignore effort, so this block simply does not
           appear for them, and picks its own slider/list presentation from
           `composerBehavior.effortSelectorMode`. */
        <EffortSelector session={session} disabled={disabled} />
      }
    />
  )
}

// Exported for tests so the pure helpers can be exercised without rendering.
// `groupByProvider` now lives with the shared control; re-exported here so the
// existing suite keeps its single import site.
export const __testing__ = { collectModelOptions, groupByProvider }
