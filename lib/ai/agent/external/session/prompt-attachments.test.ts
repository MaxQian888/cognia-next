import type { ExternalAgentImageContent } from "@/types/agent/external-agent"
import { agentModelVision, decidePromptImages } from "./prompt-attachments"
import type { ExternalAgentModelSurface } from "./session-models"

const image = (data: string): ExternalAgentImageContent => ({
  type: "image",
  source: { type: "base64", data, mediaType: "image/png" },
})

const surface = (
  currentModelId: string | null,
  choices: ExternalAgentModelSurface["choices"]
): ExternalAgentModelSurface => ({ choices, currentModelId, write: { kind: "none" } })

describe("decidePromptImages", () => {
  const images = [image("a"), image("b")]

  it("delivers nothing and withholds nothing for a turn without images", () => {
    expect(
      decidePromptImages({ images: [], agentImages: "unsupported", modelVision: false })
    ).toEqual({ delivered: [], withheld: null })
  })

  it("delivers every image when the agent and its model can read them", () => {
    const result = decidePromptImages({ images, agentImages: "native", modelVision: true })
    expect(result).toEqual({ delivered: images, withheld: null })
    expect(result.delivered).not.toBe(images)
  })

  it("delivers on an unknown agent row and an unreported model", () => {
    expect(
      decidePromptImages({ images, agentImages: "unknown", modelVision: undefined }).withheld
    ).toBeNull()
    expect(
      decidePromptImages({ images, agentImages: undefined, modelVision: undefined }).delivered
    ).toHaveLength(2)
  })

  it("withholds every image from an agent with no image input, before asking the model", () => {
    expect(
      decidePromptImages({ images, agentImages: "unsupported", modelVision: false, modelName: "m" })
    ).toEqual({ delivered: [], withheld: { reason: "agent", count: 2 } })
  })

  it("withholds every image from a model that reports no vision, naming it", () => {
    expect(
      decidePromptImages({
        images,
        agentImages: "native",
        modelVision: false,
        modelName: "DeepSeek V4 Pro",
      })
    ).toEqual({ delivered: [], withheld: { reason: "model", count: 2, model: "DeepSeek V4 Pro" } })
    expect(
      decidePromptImages({ images, agentImages: "equivalent", modelVision: false }).withheld
    ).toEqual({ reason: "model", count: 2 })
  })
})

describe("agentModelVision", () => {
  const live = surface("flash", [
    { modelId: "flash", name: "Flash", capabilities: { vision: true } },
    { modelId: "pro", name: "Pro", capabilities: { vision: false } },
  ])
  const catalog = surface(null, [{ modelId: "legacy", name: "Legacy" }])

  it("answers for the turn's explicit pick", () => {
    expect(agentModelVision({ modelId: "pro", surfaces: [live, catalog] })).toEqual({
      modelId: "pro",
      vision: false,
      name: "Pro",
    })
  })

  it("falls back to the first surface's current model", () => {
    expect(agentModelVision({ modelId: undefined, surfaces: [null, live] })).toEqual({
      modelId: "flash",
      vision: true,
      name: "Flash",
    })
  })

  it("reads a later surface when the first does not list the model", () => {
    expect(agentModelVision({ modelId: "legacy", surfaces: [live, catalog] })).toEqual({
      modelId: "legacy",
      vision: undefined,
      name: "Legacy",
    })
  })

  it("knows nothing when no surface names a model", () => {
    expect(agentModelVision({ modelId: undefined, surfaces: [catalog, undefined] })).toEqual({
      modelId: undefined,
      vision: undefined,
      name: undefined,
    })
    expect(agentModelVision({ modelId: "ghost", surfaces: [live] })).toEqual({
      modelId: "ghost",
      vision: undefined,
      name: undefined,
    })
  })
})
