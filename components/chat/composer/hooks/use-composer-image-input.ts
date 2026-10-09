"use client"

/**
 * Whether the images (and video) staged in the composer will reach the model,
 * known BEFORE the send rather than reported by a toast after it.
 *
 * The external lane hands an agent its turn's images (attached ones, and the
 * frames sampled from a video) when the agent and its model can see them;
 * this predicts the same verdict `resolvePromptAttachments` reaches at send:
 *
 * - `agent-no-images`: the agent takes no image input: its protocol has no
 *   image slot, or an ACP agent negotiated none (the capability profile's
 *   `images` cell). Before an ACP agent first connects that cell is `unknown`
 *   and nothing is predicted; the send decides and says so.
 * - `model-no-vision`: the model it runs reports no vision: the agent's own
 *   catalog (`capabilities.vision`), or the app's metadata for a Cognia model.
 *   On the built-in lane, the model's catalog entry. Only an explicit "no"
 *   counts: a model nothing describes is assumed to see, because a warning on
 *   every attachment for every uncatalogued model would teach users to ignore
 *   it.
 * - `host-outdated`: a paired Host too old to take images on a turn.
 *
 * Advisory, like the video route: nothing is blocked, and text extracted from
 * an image always goes.
 */

import { useMemo } from "react"

import type { ChatSession } from "@cognia/agent-config-types"
import type { ExternalAgentCapabilityLevel } from "@cognia/agent-config-types/external-agent-capability"
import { useExternalAgentActiveModel } from "@/hooks/agent/use-external-agent-active-model"
import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { buildDeclaredCapabilityProfile } from "@/lib/ai/agent/external/capability/capability-profile"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { hostSupportsAttachmentTurns } from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import { isExternalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { resolveAppDefaultModel } from "@/lib/ai/app-default-model"
import { resolveModelMeta } from "@/lib/ai/model-options"
import { getAllProviders } from "@cognia/provider-types/provider"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useSettingsStore } from "@/stores/settings"

export type ComposerImageInput =
  | { accepted: true }
  | { accepted: false; reason: "agent-no-images"; agentName: string | null }
  | {
      accepted: false
      reason: "model-no-vision"
      modelName: string
      /** The external agent running the model; `null` on the built-in lane. */
      agentName: string | null
    }
  | { accepted: false; reason: "host-outdated"; agentName: string | null }

const ACCEPTED: ComposerImageInput = Object.freeze({ accepted: true })

/** The external lane's verdict from what is known now. Pure, for the hook. */
export function externalImageInputVerdict(input: {
  agentName: string | null
  /** The turn runs on a paired Host's agent. */
  hostLane: boolean
  /** That Host takes images on a turn. */
  hostTakesImages: boolean
  /** The agent's `images` capability level, when known. */
  agentImages: ExternalAgentCapabilityLevel | undefined
  /** The running model's vision, when reported. */
  modelVision: boolean | undefined
  modelName: string | undefined
}): ComposerImageInput {
  const { agentName } = input
  if (input.hostLane && !input.hostTakesImages) {
    return { accepted: false, reason: "host-outdated", agentName }
  }
  if (input.agentImages === "unsupported") {
    return { accepted: false, reason: "agent-no-images", agentName }
  }
  if (input.modelVision === false && input.modelName) {
    return { accepted: false, reason: "model-no-vision", modelName: input.modelName, agentName }
  }
  return ACCEPTED
}

/** A built-in or Cognia model's display name from the provider catalog. */
function catalogModelName(providerId: string, modelId: string): string {
  return getAllProviders()[providerId]?.models?.find((m) => m.id === modelId)?.name ?? modelId
}

export function useComposerImageInput(session: ChatSession | null | undefined): ComposerImageInput {
  const agentModels = useExternalAgentModels(session?.id)
  const agentId = agentModels.agentId
  const activeAgentModel = useExternalAgentActiveModel(agentId, session, agentModels.surface)
  const runtimeRef = useRuntimeRefForSession(session?.id)
  // Re-read the agent's capability profile whenever its connection moves: an
  // ACP agent's image input is only known once it has negotiated.
  const connection = useExternalAgentStore((s) =>
    agentId ? s.connectionStatus[agentId] : undefined
  )
  const protocol = useExternalAgentStore((s) => (agentId ? s.agents[agentId]?.protocol : undefined))
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)

  return useMemo(() => {
    if (agentId) {
      const hostLane = runtimeRef?.kind === "host"
      const profile = hostLane
        ? undefined
        : (getExternalAgentManager().getAgentCapabilityProfile(agentId) ??
          (protocol ? buildDeclaredCapabilityProfile({ protocol }) : undefined))
      const cognia = activeAgentModel.cognia
      const modelVision = cognia
        ? resolveModelMeta(cognia.providerId, cognia.modelId, providerSettings, customProviders)
            .supportsVision
        : activeAgentModel.model?.capabilities?.vision
      const modelName = cognia
        ? catalogModelName(cognia.providerId, cognia.modelId)
        : (activeAgentModel.model?.name ?? activeAgentModel.modelId)
      return externalImageInputVerdict({
        agentName: agentModels.agentName,
        hostLane,
        hostTakesImages: hostLane ? hostSupportsAttachmentTurns() : true,
        agentImages: profile?.effective.images?.level,
        modelVision,
        modelName,
      })
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
    return {
      accepted: false,
      reason: "model-no-vision",
      modelName: catalogModelName(providerId, modelId),
      agentName: null,
    }
    // `connection` is read for its change, not its value: the profile the
    // manager holds is rebuilt on connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    agentModels.agentName,
    activeAgentModel,
    runtimeRef?.kind,
    connection,
    protocol,
    session?.model,
    session?.providerOverride,
    defaultModel,
    defaultProvider,
    providerSettings,
    customProviders,
  ])
}
