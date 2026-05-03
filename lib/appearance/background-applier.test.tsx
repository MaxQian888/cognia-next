/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"

// Mock the storage module so we control resolveSourceToCss output.
jest.mock("@/lib/appearance/wallpaper-storage", () => ({
  resolveSourceToCss: jest.fn(),
  disposeUrl: jest.fn(),
}))

// Mock the settings store with a manual selector implementation.
jest.mock("@/stores/settings", () => {
  const state: {
    background: BackgroundSettings
    wallpapers: Wallpaper[]
    customCss: string
    customCssEnabled: boolean
  } = {
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    wallpapers: [],
    customCss: "",
    customCssEnabled: false,
  }
  return {
    useSettingsStore: jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    __setStoreState: (patch: Partial<typeof state>) => {
      Object.assign(state, patch)
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wallpaperStorage = require("@/lib/appearance/wallpaper-storage") as {
  resolveSourceToCss: jest.Mock
  disposeUrl: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const settingsModule = require("@/stores/settings") as {
  useSettingsStore: jest.Mock
  __setStoreState: (patch: Record<string, unknown>) => void
}

import { BackgroundApplier, __INTERNALS__ } from "./background-applier"

const wallpaper = (id: string, source: Wallpaper["source"], builtin = false): Wallpaper => ({
  id,
  name: id,
  kind: source.kind,
  builtin,
  createdAt: 1,
  source,
})

beforeEach(() => {
  document.body.removeAttribute(__INTERNALS__.ATTR_ENABLED)
  document.body.removeAttribute(__INTERNALS__.ATTR_SCOPE)
  document.body.removeAttribute("data-bg-kind")
  document.body.removeAttribute("style")
  jest.clearAllMocks()
  settingsModule.__setStoreState({
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    wallpapers: [],
    customCss: "",
    customCssEnabled: false,
  })
})

describe("BackgroundApplier", () => {
  it("disables the background when no active wallpaper", async () => {
    settingsModule.__setStoreState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: false, activeId: null },
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_ENABLED)).toBe("false")
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCOPE)).toBeNull()
  })

  it("falls back to disabled when activeId references a missing wallpaper", async () => {
    settingsModule.__setStoreState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "missing" },
      wallpapers: [],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_ENABLED)).toBe("false")
  })

  it("sets CSS variables and data attributes for an active gradient wallpaper", async () => {
    const wp = wallpaper("wp-1", { kind: "gradient", css: "linear-gradient(0,red,blue)" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("linear-gradient(0,red,blue)")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-1",
        scope: "chat",
        blurPx: 8,
        opacity: 0.7,
        position: "cover",
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    const body = document.body
    expect(body.style.getPropertyValue(__INTERNALS__.VAR_IMAGE)).toBe("linear-gradient(0,red,blue)")
    expect(body.style.getPropertyValue(__INTERNALS__.VAR_BLUR)).toBe("8px")
    expect(body.style.getPropertyValue(__INTERNALS__.VAR_OPACITY)).toBe("0.7")
    expect(body.style.getPropertyValue(__INTERNALS__.VAR_SIZE)).toBe("cover")
    expect(body.style.getPropertyValue(__INTERNALS__.VAR_REPEAT)).toBe("no-repeat")
    expect(body.getAttribute(__INTERNALS__.ATTR_ENABLED)).toBe("true")
    expect(body.getAttribute(__INTERNALS__.ATTR_SCOPE)).toBe("chat")
    expect(body.getAttribute("data-bg-kind")).toBe("gradient")
  })

  it("uses repeat when position is tile", async () => {
    const wp = wallpaper("wp-tile", { kind: "color", value: "#fff" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("#fff")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-tile",
        position: "tile",
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_REPEAT)).toBe("repeat")
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_SIZE)).toBe("auto")
  })

  it("uses contain when position is contain", async () => {
    const wp = wallpaper("wp-contain", { kind: "color", value: "#000" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("#000")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-contain",
        position: "contain",
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_SIZE)).toBe("contain")
  })

  it("logs and falls back to disabled on resolveSourceToCss errors", async () => {
    const wp = wallpaper("broken", {
      kind: "image",
      storage: "indexeddb",
      blobKey: "missing",
      mime: "image/png",
      width: 1,
      height: 1,
    })
    wallpaperStorage.resolveSourceToCss.mockRejectedValue(new Error("boom"))
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    settingsModule.__setStoreState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "broken" },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    // Wait one tick for the rejected promise to land in the catch branch.
    await act(async () => {
      await Promise.resolve()
    })
    expect(warnSpy).toHaveBeenCalled()
    expect(document.body.getAttribute(__INTERNALS__.ATTR_ENABLED)).toBe("false")
    warnSpy.mockRestore()
  })

  it("renders nothing visible", async () => {
    settingsModule.__setStoreState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
    })
    let result: ReturnType<typeof render> | undefined
    await act(async () => {
      result = render(<BackgroundApplier />)
    })
    expect(result?.container.innerHTML).toBe("")
  })
})
