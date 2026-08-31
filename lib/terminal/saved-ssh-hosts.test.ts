let settingsState: { settings: unknown } = { settings: null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

import { readSavedSshHosts, selectSavedSshHosts } from "./saved-ssh-hosts"

const PROFILE = {
  id: "s1",
  name: "prod-web-01",
  host: "10.0.4.21",
  port: 22,
  username: "deploy",
  authMethod: "privateKey" as const,
}

/**
 * These cases exist because the bug they pin was invisible: reading a key
 * `AppSettings` does not have returns `undefined`, which every downstream
 * surface renders as "you have no saved hosts". The only way to catch it is to
 * assert against the shape the settings editor actually writes.
 */
describe("selectSavedSshHosts", () => {
  it("reads the path Settings to Terminal writes", () => {
    expect(
      selectSavedSshHosts({ settings: { terminal: { sshHosts: [PROFILE] } } } as never)
    ).toEqual([PROFILE])
  })

  it("returns the stored array by reference, so subscribers do not re-render", () => {
    const sshHosts = [PROFILE]
    const state = { settings: { terminal: { sshHosts } } } as never
    expect(selectSavedSshHosts(state)).toBe(sshHosts)
    expect(selectSavedSshHosts(state)).toBe(selectSavedSshHosts(state))
  })

  it("is undefined before settings load, rather than throwing on a null store", () => {
    expect(selectSavedSshHosts({ settings: null })).toBeUndefined()
  })

  it("is undefined when no SSH host has ever been saved", () => {
    expect(selectSavedSshHosts({ settings: { terminal: {} } } as never)).toBeUndefined()
  })
})

describe("readSavedSshHosts", () => {
  it("reads the live store", () => {
    settingsState = { settings: { terminal: { sshHosts: [PROFILE] } } }
    expect(readSavedSshHosts()).toEqual([PROFILE])
  })

  it("is one stable empty list before settings load", () => {
    settingsState = { settings: null }
    expect(readSavedSshHosts()).toEqual([])
    expect(readSavedSshHosts()).toBe(readSavedSshHosts())
  })
})
