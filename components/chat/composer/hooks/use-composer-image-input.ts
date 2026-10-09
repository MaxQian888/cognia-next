"use client"

/**
 * Whether the images (and video) staged in the composer will reach the model,
 * known BEFORE the send rather than reported by a toast after it.
 *
 * Two different "no"s:
 *
 * - `text-only-agent`: an external agent's lane. Its executors take one prompt
 *   string (`externalTurnPrompt` in the chat controller), so no image or video
 *   reaches any external agent, whatever its model can read. The controller
 *   still warns after the send; this says it while the user can act on it.
 * - `model-no-vision`: the built-in lane, on a model whose catalog explicitly
 *   says `supportsVision: false`. Only an explicit "no" counts: a model the
 *   catalog does not describe is assumed to read images, because a warning on
 *   every attachment for every uncatalogued model would teach users to ignore
 *   it.
 *
 * Advisory, like the video route: nothing is blocked.
 */

import { useMemo } from "react"

import type { ChatSession } from "@cognia/agent-config-types"
import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { isExternalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { resolveAppDefaultModel } from "@/lib/ai/app-default-model"
import { resolveModelMeta } from "@/lib/ai/model-options"
import { getAllProviders } from "@cognia/provider-types/provider"
import { useSettingsStore } from "@/stores/settings"

export type ComposerImageInput =
  | { accepted: true }
  | { accepted: false; reason: "text-only-agent"; agentName: string | null }
  | { accepted: false; reason: "model-no-vision"; modelName: string }

const ACCEPTED: ComposerImageInput = Object.freeze({ accepted: true })

export function useComposerImageInput(session: ChatSession | null | undefined): ComposerImageInput {
  const agentModels = useExternalAgentModels(session?.id)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)

  return useMemo(() => {
    if (agentModels.agentId) {
      return { accepted: false, reason: "text-only-agent", agentName: agentModels.agentName }
    }
    // The built-in lane, resolved the way the model chip labels it: the row's
    // own pick unless an agent stamped it, then the app default.
    const rowIsAgentPick = isExternalAgentProviderId(session?.providerOverride)
    const appDefault = resolveAppDefaultModel({ defaultModel, defaultProvider })
    const modelId = (rowIsAgentPick ? undefined : session?.model) ?? appDefault.model
    const providerId =
      (rowIsAgentPick ? undefined : session?.providerOverride) ?? appDefault.provider
    if (!modelId || !providerId) return ACCEPTED
    const meta = resolveModelMeta(providerId, modelId, providerSettings, customProviders)
    if (meta.supportsVision !== false) return ACCEPTED
    const name = getAllProviders()[providerId]?.models?.find((m) => m.id === modelId)?.name
    return { accepted: false, reason: "model-no-vision", modelName: name ?? modelId }
  }, [
    agentModels.agentId,
    agentModels.agentName,
    session?.model,
    session?.providerOverride,
    defaultModel,
    defaultProvider,
    providerSettings,
    customProviders,
  ])
}
