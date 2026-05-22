import { render, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { SettingsHydrator } from "./settings-hydrator"
import { getSettings } from "@/lib/db/settings"
import { BOOT_MIRROR_STORAGE_KEY } from "@/lib/appearance/boot-script"

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

let mockResolvedTheme: "light" | "dark" | undefined = "dark"
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}))

describe("SettingsHydrator", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })
    window.localStorage.clear()
    mockResolvedTheme = "dark"
  })

  it("calls load() on mount and transitions loaded → true", async () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(useSettingsStore.getState().loaded).toBe(true)
    })
  })

  it("is idempotent — second mount does not re-call getSettings", async () => {
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

  it("writes the appearance mirror to localStorage when resolvedTheme is available", async () => {
    render(<SettingsHydrator />)
    await waitFor(() => {
      const raw = window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)
      expect(raw).not.toBeNull()
    })
    const raw = window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY) ?? "{}"
    const mirror = JSON.parse(raw) as Record<string, string>
    expect(typeof mirror["--background"]).toBe("string")
    expect(typeof mirror["--foreground"]).toBe("string")
    expect(typeof mirror["--primary"]).toBe("string")
    expect(typeof mirror["--accent"]).toBe("string")
  })

  it("does not write the mirror until next-themes has resolved", () => {
    mockResolvedTheme = undefined
    render(<SettingsHydrator />)
    expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).toBeNull()
  })
})
