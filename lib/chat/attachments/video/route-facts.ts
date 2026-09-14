/**
 * Assemble {@link VideoRouteFacts} from what a caller knows about a turn.
 *
 * Shared by the composer (which knows the conversation's stored model and the
 * app defaults) and the controller (which knows the resolved `SendOptions`), so
 * "does this model take video" and "which protocol is this provider" are
 * answered by one function on both sides of the send.
 */

import type { AgentRuntimeAdapterId } from "@cognia/agent-config-types/agent-execution"
import type { CustomProviderSettings, UserProviderSettings } from "@cognia/provider-types/provider"
import { runtimeFromLegacy } from "@/lib/ai/agent/execution/legacy-mapping"
import { resolveModelMeta } from "@/lib/ai/model-options"
import { resolveVideoRouteProtocol, type VideoRouteFacts } from "./delivery-gate"

export interface VideoRouteInput {
  providerId: string | null | undefined
  modelId: string | null | undefined
  /** When absent, derived the way dispatch derives it from the provider. */
  runtimeAdapter?: AgentRuntimeAdapterId | null
  providerSettings?: Record<string, UserProviderSettings>
  customProviders?: CustomProviderSettings[]
  platformBound?: boolean
  teamRoom?: boolean
  sharedCollaboration?: boolean
  externalAgent?: boolean
  standalone?: boolean
  autoRouting?: boolean
}

export function videoRouteFacts(input: VideoRouteInput): VideoRouteFacts {
  const providerId = input.providerId ?? undefined
  const modelId = input.modelId ?? undefined
  const runtimeAdapter = input.runtimeAdapter ?? runtimeFromLegacy({ provider: providerId })
  const meta =
    providerId && modelId
      ? resolveModelMeta(providerId, modelId, input.providerSettings, input.customProviders)
      : {}
  return {
    providerId,
    modelId,
    runtimeAdapter,
    protocol: resolveVideoRouteProtocol(providerId, modelId, input.customProviders),
    supportsVideo: (meta as { supportsVideo?: boolean }).supportsVideo === true,
    platformBound: input.platformBound === true,
    teamRoom: input.teamRoom === true,
    sharedCollaboration: input.sharedCollaboration === true,
    externalAgent: input.externalAgent === true,
    standalone: input.standalone === true,
    autoRouting: input.autoRouting === true,
  }
}
