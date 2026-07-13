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

  it("writes the appearance mirror to localStorage for a non-default theme", async () => {
    // The default preset is governed by globals.css and is intentionally NOT
    // mirrored (see the default-base test below); a color preset is. Mark the
    // store loaded so the mount's load() early-returns instead of resetting
    // colorTheme back to "default".
    useSettingsStore.setState({
      settings: { id: "singleton" } as never,
      loaded: true,
      colorTheme: "ocean",
      activeCustomThemeId: null,
    })
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

  it("does not write the mirror for the default preset, and clears any stale one", async () => {
    // Seed a stale mirror as if a custom theme had previously been active.
    window.localStorage.setItem(
      BOOT_MIRROR_STORAGE_KEY,
      JSON.stringify({ "--background": "#0b1220" })
    )
    // Default base: colorTheme "default" + no active custom theme. loaded:true
    // keeps load() from re-deriving the flat fields.
    useSettingsStore.setState({
      settings: { id: "singleton" } as never,
      loaded: true,
      colorTheme: "default",
      activeCustomThemeId: null,
    })
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).toBeNull()
    })
  })

  it("mirrors non-default layout knobs (radius/density) even for the default preset", async () => {
    useSettingsStore.setState({
      settings: {
        id: "singleton",
        radius: { base: 1 },
        density: { global: "spacious" },
      } as never,
      loaded: true,
      colorTheme: "default",
      activeCustomThemeId: null,
    })
    render(<SettingsHydrator />)
    await waitFor(() => {
      expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).not.toBeNull()
    })
    const mirror = JSON.parse(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY) ?? "{}")
    expect(mirror.vars["--radius"]).toBe("1rem")
    expect(mirror.attrs["data-density"]).toBe("spacious")
    // Default preset ⇒ no color vars in the mirror.
    expect(mirror["--background"]).toBeUndefined()
  })

  it("skips color mirroring while a plugin theme is directly active", async () => {
    useSettingsStore.setState({
      settings: { id: "singleton" } as never,
      loaded: true,
      colorTheme: "ocean",
      activeCustomThemeId: null,
      activePluginThemeId: "demo.neon",
    })
    render(<SettingsHydrator />)
    // A plugin theme paints via <style>, so no inline color mirror; and with
    // no non-default layout knobs the mirror is cleared entirely.
    await waitFor(() => {
      expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).toBeNull()
    })
  })

  it("does not write the mirror until next-themes has resolved", () => {
    mockResolvedTheme = undefined
    render(<SettingsHydrator />)
    expect(window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)).toBeNull()
  })
})
