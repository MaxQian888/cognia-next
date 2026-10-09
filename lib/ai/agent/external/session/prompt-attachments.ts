/**
 * Which of a turn's images an external agent can actually read.
 *
 * Two independent answers, both required:
 *
 * - The agent: does its prompt have an image slot at all? That is the merged
 *   capability profile's `images` cell — the protocol's row, refined by what an
 *   ACP agent negotiated (`promptCapabilities.image`). `unknown` passes: an
 *   adapter refuses an image it cannot carry loudly, so optimism costs a clear
 *   error at worst, never a silent drop.
 * - The model: does the model the agent runs take images? Its own catalog
 *   (`capabilities.vision`) or, on a Cognia model, the app's model metadata.
 *   Only an explicit `false` withholds, the same rule the composer's notice
 *   applies: an uncatalogued model is assumed to see.
 *
 * Pure: the manager collects the inputs and this decides what they mean, so
 * the Host and the local lane reach the same verdict from the same facts.
 */

import type {
  ExternalAgentImageContent,
  ExternalAgentPromptAttachmentResolution,
} from "@/types/agent/external-agent"
import type { ExternalAgentCapabilityLevel } from "@cognia/agent-config-types/external-agent-capability"
import type { ExternalAgentModelSurface } from "./session-models"

const NOTHING: ExternalAgentPromptAttachmentResolution = Object.freeze({
  delivered: [],
  withheld: null,
}) as ExternalAgentPromptAttachmentResolution

export function decidePromptImages(input: {
  images: readonly ExternalAgentImageContent[]
  /** The profile's `images` level; `undefined` when no profile exists yet. */
  agentImages: ExternalAgentCapabilityLevel | undefined
  /** The running model's vision; `undefined` when nothing reports it. */
  modelVision: boolean | undefined
  /** The model's display name, for a `model` refusal. */
  modelName?: string
}): ExternalAgentPromptAttachmentResolution {
  const { images } = input
  if (images.length === 0) return NOTHING
  if (input.agentImages === "unsupported") {
    return { delivered: [], withheld: { reason: "agent", count: images.length } }
  }
  if (input.modelVision === false) {
    return {
      delivered: [],
      withheld: {
        reason: "model",
        count: images.length,
        ...(input.modelName ? { model: input.modelName } : {}),
      },
    }
  }
  return { delivered: [...images], withheld: null }
}

/**
 * What the agent's own catalog says about the model a turn will run on.
 *
 * `modelId` is the turn's explicit pick; without one, the first surface that
 * names a current model answers. Surfaces are read in the order given (the
 * conversation's live session first, then the catalog), and the first one that
 * lists the model describes it.
 */
export function agentModelVision(input: {
  modelId: string | undefined
  surfaces: ReadonlyArray<ExternalAgentModelSurface | null | undefined>
}): { modelId: string | undefined; vision: boolean | undefined; name: string | undefined } {
  const surfaces = input.surfaces.filter((surface): surface is ExternalAgentModelSurface =>
    Boolean(surface)
  )
  const modelId =
    input.modelId || surfaces.find((surface) => surface.currentModelId)?.currentModelId || undefined
  if (!modelId) return { modelId: undefined, vision: undefined, name: undefined }
  for (const surface of surfaces) {
    const choice = surface.choices.find((candidate) => candidate.modelId === modelId)
    if (choice) return { modelId, vision: choice.capabilities?.vision, name: choice.name }
  }
  return { modelId, vision: undefined, name: undefined }
}
