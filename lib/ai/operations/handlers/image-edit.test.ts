/** @jest-environment node */
jest.mock("./ai-sdk-surface", () => ({ generateImageGated: jest.fn() }))
const surface = jest.requireMock("./ai-sdk-surface") as { generateImageGated: jest.Mock }
const client: Record<string, unknown> = {}
jest.mock("@/lib/ai/provider-consumption", () => ({ createFeatureProviderClient: () => client }))

import { imagesEditOutput } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { IMAGE_EDIT_HANDLERS } from "./image-edit"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://api.openai.com/v1",
  model: undefined,
  isCustomProvider: false,
  useProxy: false,
}
const registry = new ProviderOperationHandlerRegistry()
for (const handler of IMAGE_EDIT_HANDLERS) registry.register(handler)
const run = (input: unknown) =>
  registry.resolve("images.edit", "openai", "openai")!.handler({
    descriptor: getProviderOperationDescriptor("images.edit")!,
    provider,
    settings: { defaultProvider: undefined, providers: {}, customProviders: [] },
    request: { operationId: "images.edit", scopes: ["provider:invoke"], surface: "sidecar", input },
  })

describe("images.edit", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of Object.keys(client)) delete client[key]
  })

  it("edits through the SDK image model's image-and-mask prompt form", async () => {
    client.imageModel = (id: string) => ({ id })
    surface.generateImageGated.mockResolvedValueOnce({
      images: [{ base64: "out", mediaType: "image/png" }],
    })
    const output = await run({
      model: "gpt-image-1",
      prompt: "add a hat",
      image: { base64: "aW1n", mimeType: "image/png" },
      mask: { dataUrl: "data:image/png;base64,bWFzaw==" },
      n: 1,
      size: "1024x1024",
    })
    expect(imagesEditOutput.parse(output)).toEqual({
      images: [{ base64: "out", mimeType: "image/png" }],
    })
    expect(surface.generateImageGated).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "gpt-image-1" },
        prompt: { images: ["aW1n"], text: "add a hat", mask: "data:image/png;base64,bWFzaw==" },
        n: 1,
        size: "1024x1024",
      })
    )
    expect(registry.resolve("images.edit", "google", "google")).toBeUndefined()
  })

  it("refuses a malformed size and a client without an image model", async () => {
    client.imageModel = (id: string) => ({ id })
    await expect(
      run({ model: "m", prompt: "p", image: { base64: "aW1n" }, size: "big" })
    ).rejects.toThrow(/size must look like/)
    delete client.imageModel
    await expect(run({ model: "m", prompt: "p", image: { base64: "aW1n" } })).rejects.toThrow(
      /no image model factory/
    )
  })
})
