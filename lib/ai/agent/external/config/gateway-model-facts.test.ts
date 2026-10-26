import { reasoningTiersFor } from "@cognia/provider-core/providers/reasoning-tiers"
import { resolveGatewayModelFacts } from "./gateway-model-facts"

const mockTransportCall = jest.fn()
let mockHeadless = false
const mockLocalFacts = jest.fn()
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => mockHeadless }))
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))
jest.mock("./cognia-model-options", () => ({
  cogniaModelReasoningFacts: (...args: unknown[]) => mockLocalFacts(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { providerSettings: { p: { enabled: true } }, customProviders: [] },
    }),
  },
}))

beforeEach(() => {
  mockHeadless = false
  mockTransportCall.mockReset()
  mockLocalFacts.mockReset()
})

describe("resolveGatewayModelFacts", () => {
  it("reads the app's own provider settings", async () => {
    const facts = { modelSupportsReasoning: () => true, modelEffortValues: () => ["low"] }
    mockLocalFacts.mockReturnValue(facts)
    await expect(resolveGatewayModelFacts("p")).resolves.toBe(facts)
    expect(mockLocalFacts).toHaveBeenCalledWith("p", {
      providerSettings: { p: { enabled: true } },
      customProviders: [],
    })
    expect(mockTransportCall).not.toHaveBeenCalled()
  })

  it("asks a headless Host's gateway, where only a recorded true takes an effort", async () => {
    mockHeadless = true
    mockTransportCall.mockResolvedValue({
      providers: [
        { id: "other", modelMetadataById: { a: { supportsReasoning: true } } },
        { id: "p", modelMetadataById: { a: { supportsReasoning: true }, b: {} } },
      ],
    })
    const facts = await resolveGatewayModelFacts("p")
    expect(mockTransportCall).toHaveBeenCalledWith("gateway_provider_capabilities")
    expect(facts.modelSupportsReasoning("a")).toBe(true)
    expect(facts.modelSupportsReasoning("b")).toBe(false)
    expect(facts.modelSupportsReasoning("unknown")).toBe(false)
    expect(facts.modelEffortValues!("a")).toEqual(
      reasoningTiersFor({ providerId: "p", modelId: "a", reasoning: true })
    )
    expect(facts.modelEffortValues!("b")).toBeUndefined()
    expect(mockLocalFacts).not.toHaveBeenCalled()
  })

  it("treats a provider the Host does not report as having no reasoning models", async () => {
    mockHeadless = true
    mockTransportCall.mockResolvedValue({})
    expect((await resolveGatewayModelFacts("p")).modelSupportsReasoning("a")).toBe(false)
  })
})
