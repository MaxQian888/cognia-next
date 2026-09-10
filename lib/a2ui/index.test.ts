import {
  DEFAULT_A2UI_PERSISTENCE_LIMIT,
  getA2UIPersistenceLimit,
  getA2UIWidgetSettingDefaults,
  getRegisteredCatalogIds,
  resolveA2UICatalogId,
  resolveWidgetDefaults,
  extractA2UIBlocks,
} from "./index"

describe("A2UI public runtime exports", () => {
  it("exposes ordered A2UI extraction with original response spans", () => {
    const payload = '{"type":"surfaceReady","surfaceId":"public"}'
    const response = `Before ${payload} after`
    const [block] = extractA2UIBlocks(response)
    expect(response.slice(block.start, block.end)).toBe(payload)
    expect(block.content.messages).toEqual([{ type: "surfaceReady", surfaceId: "public" }])
  })

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
