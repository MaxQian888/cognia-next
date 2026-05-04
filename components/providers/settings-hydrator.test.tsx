import { render } from "@testing-library/react"
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

describe("SettingsHydrator", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })
  })

  it("calls load() on mount and transitions loaded → true", async () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
    render(<SettingsHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    expect(useSettingsStore.getState().loaded).toBe(true)
  })

  it("is idempotent — second mount does not re-call getSettings", async () => {
    const { getSettings } = await import("@/lib/db/settings")
    render(<SettingsHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    ;(getSettings as jest.Mock).mockClear()
    render(<SettingsHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    expect((getSettings as jest.Mock).mock.calls.length).toBe(0)
  })
})
