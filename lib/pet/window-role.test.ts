/**
 * @jest-environment jsdom
 */
import { getPetWindowRole, PET_WINDOW_LABEL } from "./window-role"

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

  it("exposes the canonical pet window label", () => {
    expect(PET_WINDOW_LABEL).toBe("pet")
  })
})
