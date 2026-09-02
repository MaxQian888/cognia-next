/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import { DEFAULT_WALLPAPER_ROTATION } from "@/types/appearance/wallpaper-rotation"

// Mock the storage module so we control resolveSourceToCss output.
jest.mock("@/lib/appearance/wallpaper-storage", () => ({
  resolveSourceToCss: jest.fn(),
  disposeUrl: jest.fn(),
}))

// The transparent pet windows must never paint a wallpaper. Default "main" so
// the ordinary applier tests are unaffected; the pet tests flip it.
let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
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
  document.body.removeAttribute(__INTERNALS__.ATTR_SCRIM)
  document.body.removeAttribute("data-bg-kind")
  document.body.removeAttribute("data-bg-phase")
  document.body.removeAttribute("data-bg-two-layer")
  document.body.removeAttribute("data-bg-transition")
  document.body.removeAttribute("style")
  // Clear any scope target nodes a prior test may have appended.
  document.querySelectorAll("[data-bg-target]").forEach((el) => el.remove())
  jest.clearAllMocks()
  mockPetRole = "main"
  settingsModule.__setStoreState({
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    wallpapers: [],
    customCss: "",
    customCssEnabled: false,
  })
})

const imageWp = (id: string): Wallpaper =>
  wallpaper(id, {
    kind: "image",
    storage: "data-url",
    dataUrl: "data:image/png;base64,xx",
    mime: "image/png",
    width: 10,
    height: 10,
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

  it.each(["overlay", "popup"] as const)(
    "forces the wallpaper off in the %s pet window even with an active wallpaper",
    async (role) => {
      mockPetRole = role
      const wp = wallpaper("wp-1", { kind: "gradient", css: "linear-gradient(0,red,blue)" })
      wallpaperStorage.resolveSourceToCss.mockResolvedValue("linear-gradient(0,red,blue)")
      settingsModule.__setStoreState({
        background: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          enabled: true,
          activeId: "wp-1",
          scope: "all",
        },
        wallpapers: [wp],
      })
      await act(async () => {
        render(<BackgroundApplier />)
      })
      // Pet windows own no surface that should carry the app background — the
      // wallpaper pseudo-layers key off data-bg-enabled, so this keeps them off.
      expect(document.body.getAttribute(__INTERNALS__.ATTR_ENABLED)).toBe("false")
      expect(document.body.getAttribute(__INTERNALS__.ATTR_SCOPE)).toBeNull()
      // We never even resolved the wallpaper source — the gate short-circuits.
      expect(wallpaperStorage.resolveSourceToCss).not.toHaveBeenCalled()
    }
  )

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

  it("stretches both axes when position is fill", async () => {
    const wp = wallpaper("wp-fill", { kind: "color", value: "#000" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("#000")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-fill",
        position: "fill",
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_SIZE)).toBe("100% 100%")
  })

  it("anchors a cover crop at the stored focal point", async () => {
    const wp = wallpaper("wp-focal", { kind: "color", value: "#000" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("#000")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-focal",
        position: "cover",
        focalX: 100,
        focalY: 0,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_POSITION)).toBe("100% 0%")
  })

  // Rows written before the focal point existed have no focalX/focalY at all.
  it("centers when the settings row predates the focal point", async () => {
    const wp = wallpaper("wp-legacy", { kind: "color", value: "#000" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("#000")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-legacy",
        position: "cover",
        focalX: undefined,
        focalY: undefined,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.style.getPropertyValue(__INTERNALS__.VAR_POSITION)).toBe("50% 50%")
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

  it("sets data-bg-scrim on body when image wallpaper at low opacity with scope=all", async () => {
    const wp = imageWp("wp-img")
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(data:image/png;base64,xx)")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-img",
        scope: "all",
        opacity: 0.3,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBe("true")
  })

  it("does NOT set data-bg-scrim when wallpaper kind is gradient or color", async () => {
    const wp = wallpaper("wp-grad", { kind: "gradient", css: "linear-gradient(0,red,blue)" })
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("linear-gradient(0,red,blue)")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-grad",
        scope: "all",
        opacity: 0.3,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
  })

  it("does NOT set data-bg-scrim when image opacity is 0.5 or above", async () => {
    const wp = imageWp("wp-img-hi")
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(...)")
    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-img-hi",
        scope: "all",
        opacity: 0.5,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
  })

  it("clears data-bg-scrim when wallpaper is disabled", async () => {
    const wp = imageWp("wp-img")
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(...)")
    // Pre-stamp body + a stale scope target so we exercise the cleanup path.
    document.body.setAttribute(__INTERNALS__.ATTR_SCRIM, "true")
    const stale = document.createElement("div")
    stale.setAttribute("data-bg-target", "chat")
    stale.setAttribute(__INTERNALS__.ATTR_SCRIM, "true")
    document.body.appendChild(stale)

    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: false,
        activeId: null,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
    expect(stale.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
  })

  it("clears data-bg-scrim when activeId is missing", async () => {
    document.body.setAttribute(__INTERNALS__.ATTR_SCRIM, "true")
    settingsModule.__setStoreState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "missing" },
      wallpapers: [],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
  })

  it("sets data-bg-scrim on the matching scope target for scope=chat", async () => {
    const wp = imageWp("wp-chat")
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(...)")
    const chatTarget = document.createElement("div")
    chatTarget.setAttribute("data-bg-target", "chat")
    document.body.appendChild(chatTarget)
    const sidebarTarget = document.createElement("div")
    sidebarTarget.setAttribute("data-bg-target", "sidebar")
    document.body.appendChild(sidebarTarget)

    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-chat",
        scope: "chat",
        opacity: 0.3,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(chatTarget.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBe("true")
    expect(sidebarTarget.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
  })

  it("sets data-bg-scrim on every [data-bg-target] for scope=global", async () => {
    const wp = imageWp("wp-global")
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(...)")
    const a = document.createElement("div")
    a.setAttribute("data-bg-target", "chat")
    document.body.appendChild(a)
    const b = document.createElement("div")
    b.setAttribute("data-bg-target", "canvas")
    document.body.appendChild(b)

    settingsModule.__setStoreState({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        activeId: "wp-global",
        scope: "global",
        opacity: 0.2,
      },
      wallpapers: [wp],
    })
    await act(async () => {
      render(<BackgroundApplier />)
    })
    expect(a.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBe("true")
    expect(b.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBe("true")
    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBeNull()
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

describe("BackgroundApplier rotation transitions", () => {
  const rotating = (patch: Record<string, unknown> = {}) => ({
    ...DEFAULT_BACKGROUND_SETTINGS,
    enabled: true,
    rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: true, ...patch },
  })

  async function mountWith(background: BackgroundSettings, wallpapers: Wallpaper[]) {
    settingsModule.__setStoreState({ background, wallpapers })
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<BackgroundApplier />)
    })
    return view!
  }

  async function swapTo(
    view: ReturnType<typeof render>,
    background: BackgroundSettings,
    wallpapers: Wallpaper[]
  ) {
    settingsModule.__setStoreState({ background, wallpapers })
    await act(async () => {
      view.rerender(<BackgroundApplier />)
    })
  }

  it("does not animate the first paint", async () => {
    // Mounting is not a swap. Fading in from nothing on every app start would
    // read as a slow load rather than a transition.
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1")]
    await mountWith({ ...rotating(), activeId: "wp-1" }, wps)

    expect(document.body.hasAttribute("data-bg-two-layer")).toBe(false)
    expect(document.body.style.getPropertyValue("--app-bg-image")).toBe("url(one.png)")
  })

  it("crossfades onto the second layer when the wallpaper actually changes", async () => {
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1"), imageWp("wp-2")]
    const view = await mountWith({ ...rotating(), activeId: "wp-1" }, wps)

    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(two.png)")
    await swapTo(view, { ...rotating(), activeId: "wp-2" }, wps)

    expect(document.body.getAttribute("data-bg-two-layer")).toBe("true")
    expect(document.body.getAttribute("data-bg-phase")).toBe("b")
    expect(document.body.style.getPropertyValue("--app-bg-image-b")).toBe("url(two.png)")
    // The outgoing image stays on layer A so it has something to fade out from.
    expect(document.body.style.getPropertyValue("--app-bg-image")).toBe("url(one.png)")
  })

  it("does NOT animate when only a slider moved", async () => {
    // The regression this guards: the effect re-runs on every blur/opacity
    // change, and treating that as a swap would fade the wallpaper out and
    // back on every pointer move of a drag.
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1")]
    const view = await mountWith({ ...rotating(), activeId: "wp-1" }, wps)

    await swapTo(view, { ...rotating(), activeId: "wp-1", blurPx: 12 }, wps)

    expect(document.body.hasAttribute("data-bg-two-layer")).toBe(false)
    expect(document.body.style.getPropertyValue("--app-bg-blur")).toBe("12px")
  })

  it("applies instantly while rotation is off, however the wallpaper changed", async () => {
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1"), imageWp("wp-2")]
    const off = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "wp-1" }
    const view = await mountWith(off, wps)

    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(two.png)")
    await swapTo(view, { ...off, activeId: "wp-2" }, wps)

    expect(document.body.hasAttribute("data-bg-two-layer")).toBe(false)
    expect(document.body.style.getPropertyValue("--app-bg-image")).toBe("url(two.png)")
  })

  it("keeps the scrim and drops to one layer when both want ::after", async () => {
    // The whole reason `planTransition` takes `scrimActive`. Two-layer and the
    // scrim contend for the same pseudo-element, and the scrim wins.
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1"), imageWp("wp-2")]
    const dim = { ...rotating(), opacity: 0.3, scope: "all" as const }
    const view = await mountWith({ ...dim, activeId: "wp-1" }, wps)

    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(two.png)")
    await swapTo(view, { ...dim, activeId: "wp-2" }, wps)

    expect(document.body.getAttribute(__INTERNALS__.ATTR_SCRIM)).toBe("true")
    expect(document.body.hasAttribute("data-bg-two-layer")).toBe(false)
    expect(document.body.getAttribute("data-bg-transition")).toBe("fade")
  })

  it("folds a live two-layer stack back onto layer A when the background is disabled", async () => {
    // Clearing two-layer deletes the ::after that was painting the wallpaper.
    // Re-enabling with the phase still on "b" would paint into nothing.
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1"), imageWp("wp-2")]
    const view = await mountWith({ ...rotating(), activeId: "wp-1" }, wps)

    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(two.png)")
    await swapTo(view, { ...rotating(), activeId: "wp-2" }, wps)
    expect(document.body.getAttribute("data-bg-phase")).toBe("b")

    await swapTo(view, { ...rotating(), enabled: false, activeId: "wp-2" }, wps)

    expect(document.body.getAttribute("data-bg-phase")).toBe("a")
    expect(document.body.hasAttribute("data-bg-two-layer")).toBe(false)
    expect(document.body.style.getPropertyValue("--app-bg-image")).toBe("url(two.png)")
  })

  it("publishes the effective transition name for CSS to key off", async () => {
    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(one.png)")
    const wps = [imageWp("wp-1"), imageWp("wp-2")]
    const conf = rotating({ transition: "kenBurns", transitionMs: 1500 })
    const view = await mountWith({ ...conf, activeId: "wp-1" }, wps)

    wallpaperStorage.resolveSourceToCss.mockResolvedValue("url(two.png)")
    await swapTo(view, { ...conf, activeId: "wp-2" }, wps)

    expect(document.body.getAttribute("data-bg-transition")).toBe("kenBurns")
    expect(document.body.style.getPropertyValue("--app-bg-transition-duration")).toBe("1500ms")
  })
})
