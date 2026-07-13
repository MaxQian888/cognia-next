import {
  APP_SHORTCUT_CATALOG,
  getAppShortcutDescriptor,
  getDefaultAcceptedChords,
} from "./app-catalog"

describe("app-catalog", () => {
  it("every descriptor is app-scoped with a non-empty id and label key", () => {
    for (const descriptor of APP_SHORTCUT_CATALOG) {
      expect(descriptor.scope).toBe("app")
      expect(descriptor.id).toBeTruthy()
      expect(descriptor.labelKey).toMatch(/^settings\.shortcuts\.catalog\./)
      expect(descriptor.category).toBeTruthy()
    }
  })

  it("has unique ids", () => {
    const ids = APP_SHORTCUT_CATALOG.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("resolves a known descriptor by id", () => {
    const descriptor = getAppShortcutDescriptor("terminal.toggle")
    expect(descriptor?.defaultChord).toBe("ctrl+`")
    expect(descriptor?.when).toBe("platform.tauri")
  })

  it("returns undefined for an unknown id", () => {
    expect(getAppShortcutDescriptor("does.not.exist")).toBeUndefined()
  })

  it("returns the single default chord for a shortcut without alt chords", () => {
    expect(getDefaultAcceptedChords("app.search.focus")).toEqual(["/"])
  })

  it("includes normalized alt chords for a shortcut that declares them", () => {
    // zoom.in accepts both the plain `=` and the Shift `+` physical key.
    expect(getDefaultAcceptedChords("zoom.in")).toEqual(["ctrl+=", "ctrl+shift+="])
  })

  it("returns an empty list for an unknown id", () => {
    expect(getDefaultAcceptedChords("does.not.exist")).toEqual([])
  })
})
