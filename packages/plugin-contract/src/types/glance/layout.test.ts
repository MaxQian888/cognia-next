import { isPluginEntryId, parsePluginEntryId, pluginEntryId } from "./layout"

describe("plugin entry ids", () => {
  it("round-trips a plugin and module id", () => {
    const id = pluginEntryId("com.example.ci", "build-status")
    expect(id).toBe("plugin:com.example.ci:build-status")
    expect(isPluginEntryId(id)).toBe(true)
    expect(parsePluginEntryId(id)).toEqual({ pluginId: "com.example.ci", moduleId: "build-status" })
  })

  it.each([
    "fleet",
    "plugin:",
    "plugin:a",
    "plugin:a:",
    "plugin::b",
    "plugin:a:b:c",
    "plugin:a b:c",
    "plugin:-a:b",
    `plugin:${"a".repeat(129)}:b`,
    `plugin:a:${"b".repeat(65)}`,
  ])("rejects %s", (id) => {
    expect(isPluginEntryId(id)).toBe(false)
    expect(parsePluginEntryId(id)).toBeNull()
  })

  it("rejects non-strings", () => {
    expect(isPluginEntryId(42)).toBe(false)
    expect(parsePluginEntryId(undefined)).toBeNull()
  })
})
