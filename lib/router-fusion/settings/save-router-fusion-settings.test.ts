const mockSave = jest.fn(async (..._args: unknown[]) => undefined)
let mockSettings: Record<string, unknown> | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: mockSettings, save: (...args: unknown[]) => mockSave(...args) }),
  },
}))

import { DEFAULT_ROUTER_FUSION_SETTINGS } from "@cognia/router-fusion/settings/settings"

import {
  currentRouterFusionSettings,
  saveRouterFusionSettings,
} from "./save-router-fusion-settings"

describe("saveRouterFusionSettings", () => {
  beforeEach(() => {
    mockSave.mockClear()
    mockSettings = null
  })

  it("[ACC:OFF-01] reads a never-configured install as every switch off", () => {
    expect(currentRouterFusionSettings()).toEqual(DEFAULT_ROUTER_FUSION_SETTINGS)
  })

  it("persists a complete, normalized object with the patch applied", async () => {
    mockSettings = {
      routerFusion: { enabled: true, surfaces: { chat: "yes" }, breakerThreshold: 999 },
    }
    const next = await saveRouterFusionSettings({
      surfaces: { ...DEFAULT_ROUTER_FUSION_SETTINGS.surfaces, chat: true },
    })
    expect(next.enabled).toBe(true)
    expect(next.surfaces.chat).toBe(true)
    // A malformed persisted value falls back to the default rather than being trusted.
    expect(next.breakerThreshold).toBe(3)
    expect(mockSave).toHaveBeenCalledWith({ routerFusion: next })
  })

  it("applies an updater against the current settings", async () => {
    mockSettings = {
      routerFusion: {
        enabled: true,
        trippedSurfaces: { chat: { trippedAt: 1, reason: "internal" } },
      },
    }
    const next = await saveRouterFusionSettings((current) => ({
      trippedSurfaces: {
        ...current.trippedSurfaces,
        utilityLedger: { trippedAt: 2, reason: "db_unavailable" },
      },
    }))
    expect(next.trippedSurfaces).toEqual({
      chat: { trippedAt: 1, reason: "internal" },
      utilityLedger: { trippedAt: 2, reason: "db_unavailable" },
    })
  })
})
