const storeState: { loaded: boolean; settings: unknown } = { loaded: true, settings: null }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => storeState },
}))

const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))

import { currentRouterFusionGateSettings } from "./current-settings"

const LIVE = { routerFusion: { enabled: true, surfaces: { gatewayRuns: true } } }
const STORED = { routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } } }

beforeEach(() => {
  storeState.loaded = true
  storeState.settings = LIVE
  getSettings.mockReset()
})

describe("currentRouterFusionGateSettings", () => {
  it("uses the live store on the desktop window, without touching the database", async () => {
    await expect(currentRouterFusionGateSettings()).resolves.toBe(LIVE)
    expect(getSettings).not.toHaveBeenCalled()
  })

  it("reads the account row on a host that never loads the store", async () => {
    // A headless brain: `SettingsHydrator` is a React provider and never mounts
    // there. Reading the empty store would make every switch look off.
    storeState.loaded = false
    storeState.settings = null
    getSettings.mockResolvedValue(STORED)
    await expect(currentRouterFusionGateSettings()).resolves.toBe(STORED)
  })

  it("answers null — which the gate reads as off — when the row cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    storeState.loaded = false
    getSettings.mockRejectedValue(new Error("database closed"))
    await expect(currentRouterFusionGateSettings()).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("answers null for a loaded store that holds nothing", async () => {
    storeState.settings = null
    await expect(currentRouterFusionGateSettings()).resolves.toBeNull()
    expect(getSettings).not.toHaveBeenCalled()
  })
})
