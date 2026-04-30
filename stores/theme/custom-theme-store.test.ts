import { act, renderHook } from "@testing-library/react"
import { useCustomThemeStore, seedTokens, type CustomTheme } from "./custom-theme-store"
import { THEMES } from "@/lib/export/html/syntax-themes"
import * as barrel from "./"

it("barrel re-exports useCustomThemeStore and seedTokens", () => {
  expect(barrel.useCustomThemeStore).toBe(useCustomThemeStore)
  expect(barrel.seedTokens).toBe(seedTokens)
})

describe("seedTokens", () => {
  it("returns a copy of the requested built-in theme (default light)", () => {
    const tokens = seedTokens()
    expect(tokens).toEqual(THEMES.light)
    // Independent reference — mutating the result must not affect THEMES
    tokens.bg = "#000"
    expect(THEMES.light.bg).not.toBe("#000")
  })

  it("seeds from a non-default base theme when provided", () => {
    const tokens = seedTokens("dark")
    expect(tokens).toEqual(THEMES.dark)
  })
})

describe("useCustomThemeStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useCustomThemeStore.setState({ themes: [] })
  })

  const baseInput = (name = "Mine") => ({
    name,
    tokens: seedTokens("light"),
  })

  it("starts with an empty themes list", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    expect(result.current.themes).toEqual([])
  })

  it("upsert without an id creates a new entry with createdAt === updatedAt and a generated id", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    let created!: CustomTheme
    act(() => {
      created = result.current.upsert(baseInput("Solarized fork"))
    })
    expect(result.current.themes).toHaveLength(1)
    expect(created.id).toMatch(/^theme_/)
    expect(created.name).toBe("Solarized fork")
    expect(created.createdAt).toBe(created.updatedAt)
    expect(result.current.themes[0]).toEqual(created)
  })

  it("upsert with an explicit unknown id keeps that id and treats it as a new entry", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    let created!: CustomTheme
    act(() => {
      created = result.current.upsert({ id: "external-id", ...baseInput() })
    })
    expect(created.id).toBe("external-id")
    expect(result.current.themes).toHaveLength(1)
    expect(result.current.themes[0]?.id).toBe("external-id")
  })

  it("upsert with an existing id keeps createdAt and bumps updatedAt", async () => {
    const { result } = renderHook(() => useCustomThemeStore())
    let first!: CustomTheme
    act(() => {
      first = result.current.upsert({ id: "stable-id", ...baseInput("First") })
    })

    // Force a measurable delta in updatedAt
    await new Promise((r) => setTimeout(r, 5))

    let second!: CustomTheme
    act(() => {
      second = result.current.upsert({
        id: "stable-id",
        name: "Renamed",
        tokens: seedTokens("dark"),
      })
    })

    expect(result.current.themes).toHaveLength(1)
    expect(second.id).toBe("stable-id")
    expect(second.name).toBe("Renamed")
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(second.tokens).toEqual(THEMES.dark)
  })

  it("remove drops the matching entry and is a no-op when id is unknown", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    act(() => {
      result.current.upsert({ id: "a", ...baseInput("A") })
      result.current.upsert({ id: "b", ...baseInput("B") })
    })
    expect(result.current.themes.map((t) => t.id)).toEqual(["a", "b"])

    act(() => result.current.remove("a"))
    expect(result.current.themes.map((t) => t.id)).toEqual(["b"])

    // No-op
    act(() => result.current.remove("does-not-exist"))
    expect(result.current.themes.map((t) => t.id)).toEqual(["b"])
  })

  it("clone returns null for an unknown id", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    let cloned: CustomTheme | null = {} as CustomTheme
    act(() => {
      cloned = result.current.clone("missing", "Whatever")
    })
    expect(cloned).toBeNull()
  })

  it("clone copies tokens by value and assigns a fresh id", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    act(() => {
      result.current.upsert({ id: "src", ...baseInput("Source") })
    })
    let cloned: CustomTheme | null = null
    act(() => {
      cloned = result.current.clone("src", "Source copy")
    })

    expect(cloned).not.toBeNull()
    expect(cloned!.id).not.toBe("src")
    expect(cloned!.name).toBe("Source copy")

    // Mutating the clone must NOT mutate the source's tokens
    cloned!.tokens.bg = "#deadbe"
    const src = result.current.themes.find((t) => t.id === "src")!
    expect(src.tokens.bg).not.toBe("#deadbe")
  })

  it("persists under the documented localStorage key", () => {
    const { result } = renderHook(() => useCustomThemeStore())
    act(() => {
      result.current.upsert({ id: "persist-id", ...baseInput("Persisted") })
    })
    const raw = window.localStorage.getItem("cognia-custom-themes")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.themes).toHaveLength(1)
    expect(parsed.state.themes[0].id).toBe("persist-id")
  })
})
