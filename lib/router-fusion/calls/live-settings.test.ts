import type { AppSettings } from "@cognia/agent-config-types"

const storeState: { loaded: boolean; settings: AppSettings | null } = {
  loaded: true,
  settings: null,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => storeState },
}))

import { liveSettingsReader } from "./live-settings"

const SNAPSHOT = { routerFusion: { enabled: true } } as unknown as AppSettings
const LIVE = { routerFusion: { enabled: false } } as unknown as AppSettings

describe("liveSettingsReader", () => {
  it("follows the live store on the desktop window, so a mid-call toggle is seen", () => {
    storeState.loaded = true
    storeState.settings = SNAPSHOT
    const read = liveSettingsReader(SNAPSHOT)
    expect(read()).toBe(SNAPSHOT)
    storeState.settings = LIVE
    expect(read()).toBe(LIVE)
  })

  it("keeps the request's own snapshot on a host whose store never loads", () => {
    storeState.loaded = false
    storeState.settings = null
    expect(liveSettingsReader(SNAPSHOT)()).toBe(SNAPSHOT)
  })

  it("answers undefined when there is nothing to read on either side", () => {
    storeState.loaded = false
    storeState.settings = null
    expect(liveSettingsReader(null)()).toBeUndefined()
    storeState.loaded = true
    expect(liveSettingsReader(SNAPSHOT)()).toBeUndefined()
  })
})
