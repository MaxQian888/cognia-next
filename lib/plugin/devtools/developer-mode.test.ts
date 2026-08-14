/** @jest-environment jsdom */

jest.mock("@/stores/plugin-runtime/plugin-store", () => {
  const state = {
    pluginSettings: { developerModeEnabled: false },
    updatePluginSettings: jest.fn((updates: Record<string, unknown>) => {
      Object.assign(state.pluginSettings, updates)
    }),
  }
  return { usePluginStore: { getState: () => state } }
})

import {
  LEGACY_DEVELOPER_MODE_KEY,
  isDeveloperModeEnabled,
  migrateDeveloperMode,
  readLegacyDeveloperModeFlag,
  resolveInitialDeveloperMode,
  setDeveloperModeEnabled,
} from "./developer-mode"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

type MockedStore = {
  pluginSettings: { developerModeEnabled: boolean }
  updatePluginSettings: jest.Mock
}

function store(): MockedStore {
  return usePluginStore.getState() as unknown as MockedStore
}

beforeEach(() => {
  store().pluginSettings.developerModeEnabled = false
  store().updatePluginSettings.mockClear()
  window.localStorage.clear()
})

describe("resolveInitialDeveloperMode", () => {
  it("stays off when no signal is present", () => {
    expect(
      resolveInitialDeveloperMode({ stored: false, legacyFlag: false, developmentBuild: false })
    ).toBe(false)
  })

  it("turns on for any single signal", () => {
    expect(
      resolveInitialDeveloperMode({ stored: true, legacyFlag: false, developmentBuild: false })
    ).toBe(true)
    expect(
      resolveInitialDeveloperMode({ stored: false, legacyFlag: true, developmentBuild: false })
    ).toBe(true)
    expect(
      resolveInitialDeveloperMode({ stored: false, legacyFlag: false, developmentBuild: true })
    ).toBe(true)
  })

  it("never turns a stored yes back off", () => {
    // Migration is one-way: an upgrade must not silently revoke a setting the
    // user deliberately turned on in an older build.
    expect(
      resolveInitialDeveloperMode({ stored: true, legacyFlag: false, developmentBuild: false })
    ).toBe(true)
  })
})

describe("readLegacyDeveloperModeFlag", () => {
  it("reads the legacy key", () => {
    window.localStorage.setItem(LEGACY_DEVELOPER_MODE_KEY, "true")
    expect(readLegacyDeveloperModeFlag()).toBe(true)
  })

  it("treats anything but the exact string as off", () => {
    window.localStorage.setItem(LEGACY_DEVELOPER_MODE_KEY, "1")
    expect(readLegacyDeveloperModeFlag()).toBe(false)
  })

  it("is false when the key is absent", () => {
    expect(readLegacyDeveloperModeFlag()).toBe(false)
  })

  it("survives storage that throws", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    expect(readLegacyDeveloperModeFlag()).toBe(false)
    getItem.mockRestore()
  })
})

describe("store accessors", () => {
  it("reads the persisted flag", () => {
    expect(isDeveloperModeEnabled()).toBe(false)
    store().pluginSettings.developerModeEnabled = true
    expect(isDeveloperModeEnabled()).toBe(true)
  })

  it("writes through the existing settings action", () => {
    setDeveloperModeEnabled(true)
    expect(store().updatePluginSettings).toHaveBeenCalledWith({ developerModeEnabled: true })
    expect(isDeveloperModeEnabled()).toBe(true)
  })
})

describe("migrateDeveloperMode", () => {
  it("adopts the legacy key exactly once", () => {
    window.localStorage.setItem(LEGACY_DEVELOPER_MODE_KEY, "true")

    expect(migrateDeveloperMode({ developmentBuild: false })).toBe(true)
    expect(store().updatePluginSettings).toHaveBeenCalledTimes(1)

    // Idempotent: a second boot writes nothing.
    expect(migrateDeveloperMode({ developmentBuild: false })).toBe(true)
    expect(store().updatePluginSettings).toHaveBeenCalledTimes(1)
  })

  it("leaves the legacy key in place for a downgrade", () => {
    window.localStorage.setItem(LEGACY_DEVELOPER_MODE_KEY, "true")
    migrateDeveloperMode({ developmentBuild: false })
    expect(window.localStorage.getItem(LEGACY_DEVELOPER_MODE_KEY)).toBe("true")
  })

  it("writes nothing when there is no signal at all", () => {
    expect(migrateDeveloperMode({ developmentBuild: false })).toBe(false)
    expect(store().updatePluginSettings).not.toHaveBeenCalled()
  })

  it("enables on a development build", () => {
    expect(migrateDeveloperMode({ developmentBuild: true })).toBe(true)
    expect(isDeveloperModeEnabled()).toBe(true)
  })

  it("falls back to NODE_ENV when the caller says nothing", () => {
    const previous = process.env.NODE_ENV
    Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true })
    expect(migrateDeveloperMode()).toBe(true)
    Object.defineProperty(process.env, "NODE_ENV", { value: previous, configurable: true })
  })
})
