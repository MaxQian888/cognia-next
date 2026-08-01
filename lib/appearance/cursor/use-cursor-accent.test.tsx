import { renderHook } from "@testing-library/react"
import { useCursorAccentColor } from "./use-cursor-accent"
import { useSettingsStore } from "@/stores/settings"
import { BUILT_IN_DESIGNED_THEMES } from "@/lib/themes/built-in-themes"
import type { CustomTheme } from "@/types/plugin/plugin"

jest.mock("next-themes", () => ({ useTheme: jest.fn(() => ({ resolvedTheme: "dark" })) }))

import { useTheme } from "next-themes"

const useThemeMock = useTheme as jest.Mock

afterEach(() => {
  useSettingsStore.setState({
    colorTheme: "default",
    accentColor: null,
    customThemes: [],
    activeCustomThemeId: null,
    settings: null,
  })
})

describe("useCursorAccentColor", () => {
  it("returns undefined while next-themes has not settled — better than a wrong hue", () => {
    useThemeMock.mockReturnValue({ resolvedTheme: undefined })
    const { result } = renderHook(() => useCursorAccentColor())
    expect(result.current).toBeUndefined()
  })

  it("resolves the active preset's primary for the dark variant", () => {
    useThemeMock.mockReturnValue({ resolvedTheme: "dark" })
    useSettingsStore.setState({ colorTheme: "rose" })
    const { result } = renderHook(() => useCursorAccentColor())
    expect(result.current?.toLowerCase()).toBe("#fb7185")
  })

  it("resolves a different value for the light variant of the same preset", () => {
    useSettingsStore.setState({ colorTheme: "rose" })
    useThemeMock.mockReturnValue({ resolvedTheme: "light" })
    const { result: light } = renderHook(() => useCursorAccentColor())
    useThemeMock.mockReturnValue({ resolvedTheme: "dark" })
    const { result: dark } = renderHook(() => useCursorAccentColor())
    expect(light.current).not.toBe(dark.current)
  })

  it("follows a standalone accent override", () => {
    useThemeMock.mockReturnValue({ resolvedTheme: "dark" })
    useSettingsStore.setState({ accentColor: "#00b894" })
    const { result } = renderHook(() => useCursorAccentColor())
    expect(result.current?.toLowerCase()).toBe("#00b894")
  })

  it("follows an active custom theme — including the anime built-ins", () => {
    const sakura = BUILT_IN_DESIGNED_THEMES.find((t) => t.name === "Sakura")!
    const theme: CustomTheme = { ...sakura, id: "sakura-clone" }
    useThemeMock.mockReturnValue({ resolvedTheme: "dark" })
    useSettingsStore.setState({ customThemes: [theme], activeCustomThemeId: "sakura-clone" })
    const { result } = renderHook(() => useCursorAccentColor())
    expect(result.current?.toLowerCase()).toBe(sakura.tokens!.dark.primary.toLowerCase())
  })
})
