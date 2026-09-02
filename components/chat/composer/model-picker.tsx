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
// provider change, the optimistic label overlay, and the static chip rendered
// between sessions.
//
// The thinking level is NOT here. It used to ride along on two of those
// surfaces — a `· low` qualifier on the trigger and the full effort selector at
// the bottom of the popover — while `./effort-chip` rendered the same tier as
// its own labelled chip immediately to the right. One setting stated three
// times, twice within a centimetre of itself. The chip is the one that stayed:
// it is readable without opening anything, which the other two were not.

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { useState } from "react"
import { useTranslations } from "next-intl"

import { toast } from "sonner"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import { isTauri } from "@/lib/tauri"
import { useOptionalChatScope } from "@/components/chat/chat-scope-provider"
import { setSessionModel, closeSession } from "@/lib/claude/ipc"
import type { ChatSession } from "@cognia/agent-config-types"
import { collectModelOptions } from "@/lib/ai/model-options"
import {
  ModelSelect,
  groupByProvider,
  type ModelProviderGroup,
} from "@/components/shared/model-select"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"
import {
  EXTERNAL_AGENT_PROVIDER_ID,
  externalAgentProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session-models"
import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useMemo } from "react"

// The reserved group id moved next to the model vocabulary it belongs to, so
// the send path can recognise a session row this picker stamped. Re-exported
// here because this is where it was first published.
export { EXTERNAL_AGENT_PROVIDER_ID } from "@/lib/ai/agent/external/session-models"

interface ModelPickerProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

export function ModelPicker({ session, disabled, className }: ModelPickerProps) {
  const scope = useOptionalChatScope()
  const t = useTranslations("chat.composer.modelPicker")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const saveSettings = useSettingsStore((s) => s.save)
  const autoEnabled = autoRouting?.enabled === true
  // What the agent bound to THIS conversation offers. Empty on a built-in lane,
  // which is what keeps the picker unchanged for an ordinary chat.
  const agentModels = useExternalAgentModels(session?.id)
  const agentName = useExternalAgentStore((s) =>
    agentModels.agentId ? (s.agents[agentModels.agentId]?.name ?? null) : null
  )
  const agentGroups = useMemo<ModelProviderGroup[]>(() => {
    const choices = agentModels.surface?.choices ?? []
    if (choices.length === 0) return []
    return [
      {
        providerId: externalAgentProviderId(agentModels.agentId!),
        providerName: agentName ?? t("agentModelsGroup"),
        models: choices.map((choice) => ({ id: choice.modelId, name: choice.name })),
      },
    ]
  }, [agentModels.agentId, agentModels.surface, agentName, t])
  const agentStatus = useExternalAgentStore((s) =>
    agentModels.agentId ? (s.connectionStatus[agentModels.agentId] ?? "disconnected") : null
  )
  /**
   * Why the agent contributed no models, when it contributed none.
   *
   * Choosing an agent and seeing the identical provider list is the same
   * picture whether the agent is offline, has nothing open, or was asked and
   * had nothing to say. Only the last of those is "this agent has no models",
   * and the first two are one action away from being fixed.
   */
  const agentNotice = useMemo(() => {
    if (!agentModels.agentId || agentGroups.length > 0) return null
    const agent = agentName ?? t("agentModelsGroup")
    if (agentModels.loading) return t("agentModelsLoading", { agent })
    if (agentStatus !== "connected") return t("agentNotConnected", { agent })
    if (!agentModels.externalSessionId) return t("agentNoSession", { agent })
    return t("agentNoModels", { agent })
  }, [
    agentModels.agentId,
    agentModels.loading,
    agentModels.externalSessionId,
    agentGroups.length,
    agentName,
    agentStatus,
    t,
  ])
  const agentCurrentModel = agentModels.surface?.currentModelId ?? null
  const agentProviderMarker = agentModels.agentId
    ? externalAgentProviderId(agentModels.agentId)
    : EXTERNAL_AGENT_PROVIDER_ID
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

  // On an external lane the agent's own current model is the truth about what
  // the next turn runs, so it wins over the session's stored id. The session
  // row still records the choice: `applyModelToSession` replays it when the
  // agent opens a new session, which is what makes the pick survive a restart.
  const agentActive = agentModels.agentId !== null && agentCurrentModel !== null
  const activeModel =
    optimisticModel ??
    (agentActive ? agentCurrentModel : null) ??
    session?.model ??
    defaultModel ??
    ANTHROPIC_DEFAULT_MODEL
  const activeProvider =
    optimisticProvider ??
    (agentActive ? agentProviderMarker : null) ??
    session?.providerOverride ??
    defaultProvider ??
    "anthropic"

  const handleSelectAgentModel = (modelId: string) => {
    setOptimisticModel(modelId)
    setOptimisticProvider(agentProviderMarker)
    agentModels
      .select(modelId)
      .then(() => {
        // Persisted only once the agent accepted it, because this row is
        // replayed: `applyModelToSession` re-requests it on every session the
        // agent opens. Writing first meant a model the agent had refused was
        // asked for again on every restart, with the chip showing the real one.
        //
        // Stamped with the reserved provider id, because an unmarked row is
        // indistinguishable from a provider model the user chose. Switching
        // the conversation back to the built-in lane then left it dispatching
        // at an id no configured provider offers. The marker is not a provider
        // and is never used as one: `resolveSendOptions` reads it only to know
        // that this model belongs to the agent lane and skips both fields off
        // it.
        if (session?.id) {
          void updateSession(session.id, {
            model: modelId,
            providerOverride: agentProviderMarker,
          })
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        setOptimisticModel(null)
        setOptimisticProvider(null)
        toast.error(t("agentModelSwitchFailed", { reason: msg }))
      })
  }

  const handleSelect = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
    if (isExternalAgentProviderId(providerId)) {
      handleSelectAgentModel(modelId)
      return
    }
    if (!session?.id) {
      // No conversation yet, so there is no row to override. The chip is showing
      // the app default and that is exactly what the next turn will use, so the
      // selection writes the default rather than being silently dropped, which
      // is what the static label used to do.
      setOptimisticModel(modelId)
      setOptimisticProvider(providerId)
      void saveSettings({ defaultModel: modelId, defaultProvider: providerId })
      return
    }
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
    void saveSettings({
      autoRouting: { ...(autoRouting ?? DEFAULT_AUTO_ROUTING), enabled: true },
    })
    setOptimisticModel("auto")
    setOptimisticProvider("")
    if (!session?.id) return
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

  // Between sessions this used to render a plain `<span>`: a label that looked
  // like the chip and could not be opened. The model it named was the app
  // default, which IS what the next turn will use, so there was a real choice
  // being shown and no way to make it. The control stays a control, and
  // `handleSelect` writes the default when there is no row to override.
  return (
    <ModelSelect
      model={activeModel}
      provider={activeProvider}
      onSelect={handleSelect}
      onSelectAuto={handleSelectAuto}
      leadingGroups={agentGroups}
      leadingNotice={agentNotice}
      // The agent opens its session on the first turn, and nothing in any store
      // announces it. Without this the hook's one resolve, taken before that
      // turn, leaves the picker on "nothing open" for good.
      onOpen={agentModels.refresh}
      autoEnabled={autoEnabled}
      disabled={disabled}
      className={className}
    />
  )
}

// Exported for tests so the pure helpers can be exercised without rendering.
// `groupByProvider` now lives with the shared control; re-exported here so the
// existing suite keeps its single import site.
export const __testing__ = { collectModelOptions, groupByProvider }
