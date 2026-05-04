import { render, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { SettingsHydrator } from "./settings-hydrator"

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {},
    theme: "dark",
  }),
  saveSettings: jest.fn(),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
}))

jest.mock("@/lib/tts/keyring", () => ({
  loadAllProviderKeys: jest.fn().mockResolvedValue({}),
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
}))

describe("SettingsHydrator", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })
  })

  it("calls load() on mount and transitions loaded → true", async () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(useSettingsStore.getState().loaded).toBe(true)
    })
  })

  it("is idempotent — second mount does not re-call getSettings", async () => {
    const { getSettings } = await import("@/lib/db/settings")
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(useSettingsStore.getState().loaded).toBe(true)
    })
    expect((getSettings as jest.Mock).mock.calls.length).toBe(1)
    ;(getSettings as jest.Mock).mockClear()
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(useSettingsStore.getState().loaded).toBe(true)
    })
    expect((getSettings as jest.Mock).mock.calls.length).toBe(0)
  })
})
