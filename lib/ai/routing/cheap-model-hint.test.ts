/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

const mockGetState = jest.fn<{ settings: AppSettings | null }, []>()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}))

import { cheapModelHintFromSettings } from "./cheap-model-hint"

beforeEach(() => mockGetState.mockReset())

describe("cheapModelHintFromSettings", () => {
  it("returns the fast alias when the user has one", () => {
    mockGetState.mockReturnValue({
      settings: {
        providerSettings: { openai: { enabled: true, enabledModels: ["gpt-4o-mini"] } },
        modelMappings: [
          {
            id: "m1",
            alias: "fast",
            providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
            distribution: "priority",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      } as unknown as AppSettings,
    })
    expect(cheapModelHintFromSettings()).toBe("fast")
  })

  it("returns undefined when no cheap lane exists, preserving today's behaviour", () => {
    mockGetState.mockReturnValue({
      settings: {
        providerSettings: { openai: { enabled: true, enabledModels: ["gpt-4o-mini"] } },
      } as unknown as AppSettings,
    })
    expect(cheapModelHintFromSettings()).toBeUndefined()
  })

  it("returns undefined before settings have loaded", () => {
    mockGetState.mockReturnValue({ settings: null })
    expect(cheapModelHintFromSettings()).toBeUndefined()
  })
})
