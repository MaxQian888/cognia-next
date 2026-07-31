/**
 * @jest-environment jsdom
 */
import {
  getPetWindowRole,
  ISLAND_WINDOW_LABEL,
  isMainAppWindow,
  isSecondaryOverlayRole,
  PET_POPUP_WINDOW_LABEL,
  SELECTION_TOOLBAR_WINDOW_LABEL,
  PET_WINDOW_LABEL,
} from "./window-role"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean, internals?: unknown) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[TAURI_KEY] = internals ?? {}
  } else {
    delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
  }
}

describe("getPetWindowRole", () => {
  afterEach(() => setTauri(false))

  it("returns 'web' outside Tauri (and never reads the label)", () => {
    setTauri(false)
    const getLabel = jest.fn<string | undefined, []>().mockReturnValue("pet")
    expect(getPetWindowRole(getLabel)).toBe("web")
    expect(getLabel).not.toHaveBeenCalled()
  })

  it("returns 'overlay' when the Tauri label is 'pet'", () => {
    setTauri(true)
    expect(getPetWindowRole(() => PET_WINDOW_LABEL)).toBe("overlay")
  })

  it("returns 'popup' when the Tauri label is 'pet-popup'", () => {
    setTauri(true)
    expect(getPetWindowRole(() => PET_POPUP_WINDOW_LABEL)).toBe("popup")
  })

  it("returns 'main' for any other Tauri label", () => {
    setTauri(true)
    expect(getPetWindowRole(() => "main")).toBe("main")
    expect(getPetWindowRole(() => "settings")).toBe("main")
  })

  it("returns 'main' when the Tauri label is missing", () => {
    setTauri(true)
    expect(getPetWindowRole(() => undefined)).toBe("main")
  })

  it("reads the webview label from __TAURI_INTERNALS__.metadata.currentWebview by default", () => {
    setTauri(true, { metadata: { currentWebview: { label: "pet" } } })
    expect(getPetWindowRole()).toBe("overlay")
  })

  it("falls back to the window label when the webview label is absent", () => {
    setTauri(true, { metadata: { currentWindow: { label: "pet" } } })
    expect(getPetWindowRole()).toBe("overlay")
  })

  it("falls back to the window label when currentWebview exists but has no label", () => {
    setTauri(true, { metadata: { currentWebview: {}, currentWindow: { label: "pet" } } })
    expect(getPetWindowRole()).toBe("overlay")
  })

  it("defaults to 'main' when the internals metadata is entirely missing", () => {
    setTauri(true, {})
    expect(getPetWindowRole()).toBe("main")
  })

  it("returns 'island' when the Tauri label is 'island'", () => {
    setTauri(true)
    expect(getPetWindowRole(() => ISLAND_WINDOW_LABEL)).toBe("island")
  })

  it("returns 'selection-toolbar' for the selection overlay label", () => {
    setTauri(true)
    expect(getPetWindowRole(() => SELECTION_TOOLBAR_WINDOW_LABEL)).toBe("selection-toolbar")
  })

  it("exposes the canonical pet window labels", () => {
    expect(PET_WINDOW_LABEL).toBe("pet")
    expect(PET_POPUP_WINDOW_LABEL).toBe("pet-popup")
    expect(ISLAND_WINDOW_LABEL).toBe("island")
    expect(SELECTION_TOOLBAR_WINDOW_LABEL).toBe("selection-toolbar")
  })
})

describe("isSecondaryOverlayRole", () => {
  it("covers every secondary overlay window and nothing else", () => {
    expect(isSecondaryOverlayRole("overlay")).toBe(true)
    expect(isSecondaryOverlayRole("popup")).toBe(true)
    expect(isSecondaryOverlayRole("island")).toBe(true)
    expect(isSecondaryOverlayRole("selection-toolbar")).toBe(true)
    expect(isSecondaryOverlayRole("main")).toBe(false)
    expect(isSecondaryOverlayRole("web")).toBe(false)
  })
})

describe("isMainAppWindow", () => {
  afterEach(() => setTauri(false))

  it("is true on the web (single browsing context)", () => {
    setTauri(false)
    expect(isMainAppWindow(() => PET_WINDOW_LABEL)).toBe(true)
  })

  it("is true for the main Tauri window", () => {
    setTauri(true)
    expect(isMainAppWindow(() => "main")).toBe(true)
    expect(isMainAppWindow(() => undefined)).toBe(true)
  })

  it("is false for the least-privilege pet overlay window", () => {
    setTauri(true)
    expect(isMainAppWindow(() => PET_WINDOW_LABEL)).toBe(false)
  })

  it("is false for the pet click popup window", () => {
    setTauri(true)
    expect(isMainAppWindow(() => PET_POPUP_WINDOW_LABEL)).toBe(false)
  })

  it("is false for the fleet island window", () => {
    setTauri(true)
    expect(isMainAppWindow(() => ISLAND_WINDOW_LABEL)).toBe(false)
  })

  it("is false for the system selection toolbar window", () => {
    setTauri(true)
    expect(isMainAppWindow(() => SELECTION_TOOLBAR_WINDOW_LABEL)).toBe(false)
  })
})
