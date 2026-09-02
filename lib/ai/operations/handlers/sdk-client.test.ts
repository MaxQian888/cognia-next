/** @jest-environment node */
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderClient: jest.fn(() => ({
    embeddingModel: (id: string) => ({ kind: "embedding", id }),
  })),
}))
const consumption = jest.requireMock("@/lib/ai/provider-consumption") as {
  createFeatureProviderClient: jest.Mock
}

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import { providerSdkClient, requireModelFactory, requireModelId } from "./sdk-client"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://a/v1",
  model: "configured",
  isCustomProvider: false,
  useProxy: false,
  headers: { "x-app": "cognia" },
}

describe("sdk client helper", () => {
  it("threads the resolved provider into the feature client, headers included", () => {
    providerSdkClient(provider)
    expect(consumption.createFeatureProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", apiKey: "k", headers: { "x-app": "cognia" } })
    )
  })

  it("prefers the requested model, falls back to the configured one, and fails typed on neither", () => {
    expect(requireModelId(provider, " m1 ")).toBe("m1")
    expect(requireModelId(provider, undefined)).toBe("configured")
    expect(() => requireModelId({ ...provider, model: undefined }, "")).toThrow(
      ProviderOperationFailureError
    )
  })

  it("resolves the first factory the client has and fails typed when none exists", () => {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<{ id: string }>(
      client,
      provider,
      ["textEmbeddingModel", "embeddingModel"],
      "embedding"
    )
    expect(make("e1")).toEqual({ kind: "embedding", id: "e1" })
    expect(() => requireModelFactory(client, provider, ["speechModel"], "speech")).toThrow(
      /no speech model factory/
    )
  })
})
