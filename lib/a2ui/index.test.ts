import {
  DEFAULT_A2UI_PERSISTENCE_LIMIT,
  getA2UIPersistenceLimit,
  getA2UIWidgetSettingDefaults,
  getRegisteredCatalogIds,
  resolveA2UICatalogId,
  resolveWidgetDefaults,
} from "./index"

describe("A2UI public runtime exports", () => {
  it("exposes the runtime settings and catalog resolution contract", () => {
    expect(DEFAULT_A2UI_PERSISTENCE_LIMIT).toBe(20)
    expect(getA2UIPersistenceLimit({ a2uiPersistenceLimit: 12 })).toBe(12)
    expect(getRegisteredCatalogIds()).toContain("cognia-standard-v1")
    expect(resolveA2UICatalogId()).toBe("cognia-standard-v1")
    expect(getA2UIWidgetSettingDefaults({ a2uiDefaultTheme: "dark" })).toEqual({
      theme: "dark",
    })
    expect(resolveWidgetDefaults(undefined, { theme: "dark" })).toMatchObject({
      hostStrategy: "native",
      sizing: "auto",
      theme: "dark",
      status: "ready",
      showChrome: true,
    })
  })
})
