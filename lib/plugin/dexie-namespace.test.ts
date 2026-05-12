import {
  toNamespacedTableName,
  fromNamespacedTableName,
  isValidPluginTableName,
  PLUGIN_TABLE_NAMESPACE_SEPARATOR,
  MAX_TABLES_PER_PLUGIN,
} from "./dexie-namespace"

describe("dexie-namespace", () => {
  describe("toNamespacedTableName", () => {
    it("joins pluginId and tableName with a colon", () => {
      expect(toNamespacedTableName("github-delivery", "repos")).toBe("github-delivery:repos")
    })
  })

  describe("fromNamespacedTableName", () => {
    it("splits on the first colon", () => {
      expect(fromNamespacedTableName("github-delivery:repos")).toEqual({
        pluginId: "github-delivery",
        tableName: "repos",
      })
    })
    it("handles plugin IDs without colons cleanly", () => {
      expect(fromNamespacedTableName("alpha:items")).toEqual({
        pluginId: "alpha",
        tableName: "items",
      })
    })
    it("returns null for non-namespaced names (core CogniaDB tables)", () => {
      expect(fromNamespacedTableName("messages")).toBeNull()
      expect(fromNamespacedTableName("")).toBeNull()
    })
    it("returns null when colon is at the start or end", () => {
      expect(fromNamespacedTableName(":items")).toBeNull()
      expect(fromNamespacedTableName("alpha:")).toBeNull()
    })
  })

  describe("isValidPluginTableName", () => {
    it.each([
      ["repos", true],
      ["workOrders", true],
      ["a", true],
      ["a1_b", true],
      ["abc123_xyz", true],
      ["", false],
      ["1startsWithDigit", false],
      ["StartsUpper", false],
      ["has-dash", false],
      ["has space", false],
      ["has:colon", false],
      ["a".repeat(32), false], // 32 chars total — leading + 31 trailing — fails (max 31 = leading + 30)
    ])("name=%j → %s", (name, expected) => {
      expect(isValidPluginTableName(name as string)).toBe(expected)
    })
    it("accepts a name at the maximum length (31 chars)", () => {
      expect(isValidPluginTableName("a" + "b".repeat(30))).toBe(true)
    })
    it("rejects non-string input", () => {
      expect(isValidPluginTableName(undefined as unknown as string)).toBe(false)
      expect(isValidPluginTableName(null as unknown as string)).toBe(false)
      expect(isValidPluginTableName(123 as unknown as string)).toBe(false)
    })
  })

  it("exposes the documented constants", () => {
    expect(PLUGIN_TABLE_NAMESPACE_SEPARATOR).toBe(":")
    expect(MAX_TABLES_PER_PLUGIN).toBe(20)
  })
})
