import type { AppSettings } from "@cognia/agent-config-types"

const searchWithSettingsMock = jest.fn()
const getStateMock = jest.fn()

jest.mock("./configured-search-core", () => ({
  searchWithSettings: (...args: unknown[]) => searchWithSettingsMock(...args),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => getStateMock() },
}))

import { searchWithAppSettings } from "./configured-search"

beforeEach(() => {
  searchWithSettingsMock.mockReset().mockResolvedValue({ results: [] })
  getStateMock.mockReset().mockReturnValue({ settings: { searchMaxResults: 5 } })
})

describe("searchWithAppSettings", () => {
  it("uses an explicit host settings snapshot without reading Zustand", async () => {
    const settings = { searchMaxResults: 2 } as AppSettings

    await searchWithAppSettings("query", { settings, useCache: false })

    expect(getStateMock).not.toHaveBeenCalled()
    expect(searchWithSettingsMock).toHaveBeenCalledWith("query", {
      settings,
      useCache: false,
    })
  })

  it("supplies the live renderer settings when the caller omits them", async () => {
    await searchWithAppSettings("query")

    expect(searchWithSettingsMock).toHaveBeenCalledWith("query", {
      settings: { searchMaxResults: 5 },
    })
  })
})
