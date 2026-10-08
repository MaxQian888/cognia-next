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
import { useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { toast } from "sonner"
import { RefreshCw, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import {
  agentHostAvailable,
  resolveAgentExecutionEnvironment,
} from "@/lib/ai/agent/execution/host-environment"
import { useOptionalChatScope } from "@/components/chat/chat-scope-provider"
import { setSessionModel, closeSession } from "@/lib/claude/ipc"
import type {
  ChatSession,
  ExternalAgentCogniaModelBinding,
  ExternalAgentModelChoice,
} from "@cognia/agent-config-types"
import { collectModelOptions } from "@/lib/ai/model-options"
import { resolveAppDefaultModel } from "@/lib/ai/app-default-model"
import {
  ModelSelect,
  groupByProvider,
  type ModelProviderGroup,
} from "@/components/shared/model-select"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"
import {
  EXTERNAL_AGENT_PROVIDER_ID,
  cogniaGatewayGroupId,
  cogniaProviderIdFromGroupId,
  externalAgentProviderId,
  isExternalAgentProviderId,
  resolveExternalAgentModelSelection,
} from "@/lib/ai/agent/external/session/session-models"
import {
  agentModelSurfaceRevision,
  lastKnownNativeSurface,
  subscribeAgentModelSurface,
} from "@/lib/ai/agent/external/capability/model-surface-cache"
import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import {
  useCogniaGatewayModels,
  type CogniaGatewayModelsReason,
} from "@/hooks/agent/use-cognia-gateway-models"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

// The reserved group id moved next to the model vocabulary it belongs to, so
// the send path can recognise a session row this picker stamped. Re-exported
// here because this is where it was first published.
export { EXTERNAL_AGENT_PROVIDER_ID } from "@/lib/ai/agent/external/session/session-models"

/**
 * The row standing for "the agent's own default model" when it has listed no
 * models of its own. Never a model id an agent reports: those are its own names,
 * and none starts with two underscores and ends with two.
 */
const AGENT_DEFAULT_MODEL_ID = "__agent-default__"

/** The i18n key for each reason the Cognia section is offered disabled. */
const COGNIA_REASON_KEYS = {
  "unsupported-runtime": "cogniaUnsupportedRuntime",
  "remote-server": "cogniaRemoteServer",
  "no-process": "cogniaNoProcess",
  "network-endpoint": "cogniaNetworkEndpoint",
  "host-update-required": "cogniaHostUpdateRequired",
  "no-eligible-models": "cogniaNoEligibleModels",
  "account-locked": "cogniaAccountLocked",
  "public-https-required": "cogniaPublicHttpsRequired",
} as const satisfies Record<CogniaGatewayModelsReason, string>

interface ModelPickerProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
  /** Short label, no chevron: see `ModelSelectProps.compactLabel`. */
  compactLabel?: boolean
}

export function ModelPicker({ session, disabled, className, compactLabel }: ModelPickerProps) {
  const scope = useOptionalChatScope()
  const t = useTranslations("chat.composer.modelPicker")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const externalAgentModelDefaults = useSettingsStore((s) => s.settings?.externalAgentModelDefaults)
  const saveSettings = useSettingsStore((s) => s.save)
  const autoEnabled = autoRouting?.enabled === true
  // What the agent bound to THIS conversation offers. `agentId` is null on a
  // built-in lane, which is what keeps the picker unchanged for an ordinary
  // chat.
  const agentModels = useExternalAgentModels(session?.id)
  const agentId = agentModels.agentId
  /**
   * An external agent runs this conversation's turns.
   *
   * Then the agent's OWN models are the only choice there is. The configured
   * providers used to be listed underneath, with the provider default ticked
   * and named on the chip: a Kimi Code conversation read "Sonnet 5" while
   * Kimi ran its own model. Auto routing goes with them, because it picks a
   * provider model tier per prompt and an external agent takes none.
   */
  const externalLane = agentId !== null
  const agentLabel = agentModels.agentName ?? t("agentFallbackName")
  // Whether the store knows this agent's connection at all. A configuration
  // the paired Host owns is not in this client's store, and "not connected"
  // said about it would be a guess.
  const agentStatus = useExternalAgentStore((s) =>
    agentId && s.agents[agentId] ? (s.connectionStatus[agentId] ?? "disconnected") : null
  )
  // A local agent's own default binding (`ExternalAgentConfig.cogniaModel`).
  // A configuration the paired Host owns is not in this store: its default is
  // the Host's, and `undefined` says this client does not know it.
  const agentDefaultBinding = useExternalAgentStore((s) =>
    agentId && s.agents[agentId] ? (s.agents[agentId].cogniaModel ?? null) : undefined
  )
  const cogniaModels = useCogniaGatewayModels(session?.id)

  // --- What this conversation runs the agent on -----------------------------
  //
  // The same resolver the send path uses, so the chip and the turn cannot
  // disagree. It reads the conversation's per-agent choice, never the
  // built-in lane's `model` / `providerOverride`.
  const [optimisticChoice, setOptimisticChoice] = useState<ExternalAgentModelChoice | null>(null)
  const selection = agentId
    ? resolveExternalAgentModelSelection({
        agentId,
        session,
        ...(agentDefaultBinding !== undefined ? { agentDefault: agentDefaultBinding } : {}),
        appDefaults: { externalAgentModelDefaults, defaultModel, defaultProvider },
      })
    : null
  const choice = optimisticChoice ?? selection?.choice ?? null
  const cogniaBinding = choice?.kind === "cognia" ? choice.binding : null
  /**
   * While a Cognia model is selected the agent's own session is not the one
   * open (the turn runs in a gateway task), so the agent may have nothing to
   * list. The last list of its own models this machine saw is offered
   * instead, seeded: a pick is recorded and applied by the next native turn.
   */
  const surfaceRevision = useSyncExternalStore(
    subscribeAgentModelSurface,
    agentModelSurfaceRevision,
    () => 0
  )
  const lastNative = useMemo(() => {
    void surfaceRevision
    return agentId ? lastKnownNativeSurface(agentId) : null
  }, [agentId, surfaceRevision])
  const usingLastNative = cogniaBinding !== null && lastNative !== null
  const nativeSurface = usingLastNative ? lastNative.surface : agentModels.surface

  const hasNativeList = (nativeSurface?.choices.length ?? 0) > 0
  /**
   * The agent's own models, or, with no list, one row for its own default.
   *
   * The list arrives with a native turn, and a paired Host reports none for a
   * turn on a Cognia model. Without the default row a conversation that began
   * on a Cognia model could never be switched back to the agent's own models.
   */
  const agentGroups = useMemo<ModelProviderGroup[]>(() => {
    if (!agentId) return []
    const choices = nativeSurface?.choices ?? []
    return [
      {
        providerId: externalAgentProviderId(agentId),
        providerName: agentLabel,
        models:
          choices.length > 0
            ? choices.map((choice) => ({
                id: choice.modelId,
                name: choice.name,
                // The agent's own catalog facts, drawn with the same glyphs
                // the built-in rows wear.
                contextLength: choice.capabilities?.contextWindow,
                supportsVision: choice.capabilities?.vision,
                supportsReasoning: choice.capabilities?.reasoning,
              }))
            : [{ id: AGENT_DEFAULT_MODEL_ID, name: t("agentDefaultModelRow"), hideId: true }],
      },
    ]
  }, [agentId, nativeSurface, agentLabel, t])

  /**
   * The Cognia models the agent can run on through the gateway, as one
   * section under the agent's own. Offered disabled, with the reason, where
   * the agent or the Host cannot: hiding it would leave "why can't I" with no
   * answer.
   */
  const cogniaGroups = useMemo<ModelProviderGroup[]>(() => {
    if (!agentId) return []
    const agent = agentLabel
    const status = cogniaModels.status
    if (status === "idle") return []
    const notice =
      status === "ready"
        ? t("cogniaSectionHint", { agent })
        : status === "loading"
          ? t("cogniaModelsLoading")
          : status === "error"
            ? t("cogniaModelsFailed")
            : t(COGNIA_REASON_KEYS[cogniaModels.reason ?? "unsupported-runtime"], { agent })
    const section = {
      id: "cognia-gateway",
      label: t("cogniaSection"),
      icon: <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden />,
      notice,
    }
    if (status !== "ready") {
      return [{ providerId: cogniaGatewayGroupId(""), providerName: "", models: [], section }]
    }
    return cogniaModels.providers.map((provider) => ({
      providerId: cogniaGatewayGroupId(provider.providerId),
      providerName: provider.providerName,
      section,
      models: provider.models.map((model) => {
        // The gateway's launch adapter refuses a model explicitly lacking
        // either; unknown stays offered, as the agent editor's picker does.
        const disabledReason =
          model.supportsTools === false
            ? t("cogniaModelNoTools")
            : model.supportsStreaming === false
              ? t("cogniaModelNoStreaming")
              : undefined
        return {
          id: model.id,
          name: model.name,
          contextLength: model.contextLength,
          supportsTools: model.supportsTools,
          supportsVision: model.supportsVision,
          supportsReasoning: model.supportsReasoning,
          ...(disabledReason ? { disabled: true, disabledReason } : {}),
        }
      }),
    }))
  }, [agentId, agentLabel, cogniaModels.status, cogniaModels.reason, cogniaModels.providers, t])
  /**
   * What to say about the agent's list, if anything.
   *
   * With no list there are several different reasons, and each reads
   * differently: still reading it, the Host has not reported it yet, asked and
   * failed, offline, or asked and offered none. With a list, the one thing
   * worth saying is when a pick cannot reach the agent until the next message.
   */
  const agentNotice = useMemo(() => {
    if (!agentId) return null
    const agent = agentLabel
    if (hasNativeList) {
      return nativeSurface?.write.kind === "session-seed" ? t("agentModelAppliesNextTurn") : null
    }
    if (agentModels.loading) return t("agentModelsLoading", { agent })
    if (agentModels.status === "deferred") return t("agentModelsDeferred", { agent })
    if (agentModels.status === "error") return t("agentModelsFailed", { agent })
    if (agentStatus !== null && agentStatus !== "connected") {
      return t("agentNotConnected", { agent })
    }
    return t("agentNoModels", { agent })
  }, [
    agentId,
    agentLabel,
    hasNativeList,
    nativeSurface,
    agentModels.loading,
    agentModels.status,
    agentStatus,
    t,
  ])
  const agentProviderMarker = agentId
    ? externalAgentProviderId(agentId)
    : EXTERNAL_AGENT_PROVIDER_ID
  // Optimistic state so the button label reflects the user's selection
  // immediately, before the parent re-renders with the updated session prop.
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null)
  const [optimisticProvider, setOptimisticProvider] = useState<string | null>(null)
  // Reset the optimistic overlay when the session or the lane changes
  // (render-time setState). A pick made for one lane says nothing about the
  // other: switching Kimi Code back to the built-in agent kept naming the Kimi
  // model until the conversation was reopened.
  const laneKey = `${session?.id ?? ""}\u0000${agentId ?? ""}`
  const [prevLaneKey, setPrevLaneKey] = useState(laneKey)
  if (prevLaneKey !== laneKey) {
    setPrevLaneKey(laneKey)
    setOptimisticModel(null)
    setOptimisticProvider(null)
    setOptimisticChoice(null)
  }

  // --- External lane -------------------------------------------------------
  //
  // The agent's own model this conversation asked for, from the resolved
  // choice above (the conversation row, or the app default a welcome-screen
  // pick writes).
  const agentPick = choice?.kind === "native" ? choice.modelId : undefined
  const agentCurrent = nativeSurface?.currentModelId ?? undefined
  // A live surface is the agent's own word on what runs, and a pick writes
  // through to it at once. A seeded one (a catalog before the first turn, or
  // what a paired Host reported after the last one) can only be changed by the
  // next turn, so until then the pick is the truer answer.
  const agentModel =
    nativeSurface?.write.kind === "session-seed"
      ? (agentPick ?? agentCurrent)
      : (agentCurrent ?? agentPick)
  const agentActiveModel = agentModel || ""
  // A Cognia model, named compactly on the chip with a Cognia glyph, and in
  // full (agent, provider, model, route) on hover.
  const cogniaProvider = cogniaBinding
    ? cogniaModels.providers.find((provider) => provider.providerId === cogniaBinding.providerId)
    : undefined
  const cogniaModelName = cogniaBinding
    ? (cogniaProvider?.models.find((model) => model.id === cogniaBinding.modelId)?.name ??
      cogniaBinding.modelId)
    : ""
  const agentTriggerLabel = cogniaBinding
    ? cogniaModelName
    : agentActiveModel
      ? (nativeSurface?.choices.find((option) => option.modelId === agentActiveModel)?.name ??
        agentActiveModel)
      : t("agentDefaultModel", { agent: agentLabel })
  const agentTriggerTitle = cogniaBinding
    ? t("cogniaChipTitle", {
        agent: agentLabel,
        provider: cogniaProvider?.providerName ?? cogniaBinding.providerId,
        model: cogniaModelName,
      })
    : undefined

  // --- Built-in lane -------------------------------------------------------
  //
  // A row or app default stamped by an agent pick names that agent's model,
  // which no provider offers. The send path skips it (`resolveSendOptions`),
  // so the chip must too, or a conversation switched back from Kimi Code kept
  // showing a Kimi model while the provider default ran.
  const rowIsAgentPick = isExternalAgentProviderId(session?.providerOverride)
  const appDefault = resolveAppDefaultModel({ defaultModel, defaultProvider })
  const activeModel = externalLane
    ? (cogniaBinding?.modelId ??
      (agentActiveModel || (hasNativeList ? agentActiveModel : AGENT_DEFAULT_MODEL_ID)))
    : (optimisticModel ??
      (rowIsAgentPick ? undefined : session?.model) ??
      appDefault.model ??
      ANTHROPIC_DEFAULT_MODEL)
  const activeProvider = externalLane
    ? cogniaBinding
      ? cogniaGatewayGroupId(cogniaBinding.providerId)
      : agentProviderMarker
    : (optimisticProvider ??
      (rowIsAgentPick ? undefined : session?.providerOverride) ??
      appDefault.provider ??
      "anthropic")

  /**
   * Record what this conversation runs the agent on.
   *
   * In the conversation's own per-agent column, or before a conversation
   * exists, in the app default `createSession` copies onto the next one. Never
   * in `model` / `providerOverride`: those are the built-in lane's pick, and it
   * survives every switch to and from an agent untouched.
   */
  const writeAgentChoice = async (next: ExternalAgentModelChoice) => {
    if (!agentId) return
    if (session?.id) {
      await updateSession(session.id, {
        externalAgentModels: { ...(session.externalAgentModels ?? {}), [agentId]: next },
      })
    } else {
      await saveSettings({
        externalAgentModelDefaults: { ...(externalAgentModelDefaults ?? {}), [agentId]: next },
      })
    }
  }

  const rollBack = (err: unknown, key: "agentModelSwitchFailed" | "cogniaModelSwitchFailed") => {
    const msg = err instanceof Error ? err.message : String(err)
    setOptimisticChoice(null)
    toast.error(t(key, { reason: msg }))
  }

  const handleSelectAgentModel = (modelId: string) => {
    if (modelId === AGENT_DEFAULT_MODEL_ID) {
      // No list means no session of the agent's own to write to: the next turn
      // runs natively on whatever the agent defaults to.
      const next: ExternalAgentModelChoice = { kind: "native" }
      setOptimisticChoice(next)
      writeAgentChoice(next).catch((err) => rollBack(err, "agentModelSwitchFailed"))
      return
    }
    const next: ExternalAgentModelChoice = { kind: "native", modelId }
    setOptimisticChoice(next)
    // The last-known list stands in for an agent with no native session open,
    // so there is nothing live to write to: the pick is recorded and the next
    // native turn applies it.
    const applied = usingLastNative ? Promise.resolve() : agentModels.select(modelId)
    applied
      // Persisted only once the agent accepted it, because the choice is
      // replayed: `applyModelToSession` re-requests it on every session the
      // agent opens. Writing first meant a model the agent had refused was
      // asked for again on every restart, with the chip showing the real one.
      .then(() => writeAgentChoice(next))
      .catch((err) => rollBack(err, "agentModelSwitchFailed"))
  }

  const handleSelectCogniaModel = (providerId: string, modelId: string) => {
    // The account a previous pick on the same provider pinned stays pinned;
    // otherwise the provider default is resolved when the task starts.
    const binding: ExternalAgentCogniaModelBinding = {
      providerId,
      modelId,
      ...(cogniaBinding?.providerId === providerId && cogniaBinding.accountId !== undefined
        ? { accountId: cogniaBinding.accountId }
        : {}),
    }
    const next: ExternalAgentModelChoice = { kind: "cognia", binding }
    setOptimisticChoice(next)
    // Nothing to write to the agent now: the next turn starts (or resumes)
    // the gateway task this binding names.
    writeAgentChoice(next).catch((err) => rollBack(err, "cogniaModelSwitchFailed"))
  }

  const handleSelect = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
    if (isExternalAgentProviderId(providerId)) {
      handleSelectAgentModel(modelId)
      return
    }
    const cogniaProviderId = cogniaProviderIdFromGroupId(providerId)
    if (cogniaProviderId) {
      if (externalLane) handleSelectCogniaModel(cogniaProviderId, modelId)
      return
    }
    // Only the agent's own models and its Cognia section are offered on an
    // external lane, so a provider pick cannot come from there. Refused
    // rather than written: the built-in lane's pick is not a choice made for
    // an agent.
    if (externalLane) return
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
    // Host truth, not webview kind: a paired phone or browser reaches the
    // host's sidecar over the companion transport (`claude_session_control` is
    // an `execution`-target command), and the headless brain owns one outright.
    // Gating on `isTauri()` here left every companion with a persisted override
    // that only took effect on the NEXT session, while the running one kept the
    // old model with no word about it.
    if (agentHostAvailable(resolveAgentExecutionEnvironment())) {
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
    // Same host question as the live switch above: the runtime to reset lives
    // wherever the sidecar does, which a companion reaches remotely.
    if (agentHostAvailable(resolveAgentExecutionEnvironment())) {
      const reset =
        scope?.sessionId === session.id && scope.resetRuntime
          ? scope.resetRuntime()
          : closeSession(session.id)
      void reset.catch(() => undefined)
    }
  }

  // Only where asking again can learn something: a paired Host's lane gets its
  // list with a turn, and a button that does nothing there is a dead control.
  const refreshAgentModelsButton = agentModels.canRefresh ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // Sized to the heading row it sits in (`h-6`), so the row stays the
      // height of a plain group heading.
      className="h-6 gap-1.5 px-1.5 text-xs font-normal"
      disabled={agentModels.loading}
      onClick={agentModels.refresh}
      aria-label={t("refreshAgentModels")}
    >
      <RefreshCw
        className={cn("size-3", agentModels.loading && "animate-spin motion-reduce:animate-none")}
      />
      {t("refreshAgentModels")}
    </Button>
  ) : null

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
      onSelectAuto={externalLane ? undefined : handleSelectAuto}
      hideProviderGroups={externalLane}
      triggerLabel={externalLane ? agentTriggerLabel : undefined}
      triggerIcon={
        externalLane && cogniaBinding ? (
          <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-label={t("cogniaGlyph")} />
        ) : undefined
      }
      triggerTitle={agentTriggerTitle}
      leadingGroups={[
        ...agentGroups.map((group) => ({
          ...group,
          ...(refreshAgentModelsButton ? { headingAction: refreshAgentModelsButton } : {}),
        })),
        ...cogniaGroups,
      ]}
      leadingNotice={
        externalLane && agentNotice ? (
          <span className="flex flex-col gap-1" aria-live="polite">
            <span>{agentNotice}</span>
          </span>
        ) : null
      }
      // The agent opens its session on the first turn, and nothing in any store
      // announces it. Without this the hook's one resolve, taken before that
      // turn, leaves the picker on "nothing open" for good.
      onOpen={
        agentModels.canRefresh || cogniaModels.lane === "host"
          ? () => {
              if (agentModels.canRefresh) agentModels.refresh()
              // The Host's providers and accounts can change between opens.
              if (cogniaModels.lane === "host") cogniaModels.refresh()
            }
          : undefined
      }
      autoEnabled={autoEnabled}
      disabled={disabled}
      className={className}
      compactLabel={compactLabel}
    />
  )
}

// Exported for tests so the pure helpers can be exercised without rendering.
// `groupByProvider` now lives with the shared control; re-exported here so the
// existing suite keeps its single import site.
export const __testing__ = { collectModelOptions, groupByProvider }
