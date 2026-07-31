import {
  getPluginPathViolations,
  normalizePluginRelativePath,
  resolvePluginPath,
} from "./plugin-path"
import fixtures from "@/packages/plugin-sdk/contract/path-fixtures.json"

describe("plugin path confinement", () => {
  it.each(fixtures.invalid)("rejects an unsafe plugin-relative path: %s", (entry) => {
    expect(getPluginPathViolations(entry)).not.toEqual([])
    expect(() => normalizePluginRelativePath(entry)).toThrow(/plugin-relative path/i)
  })

  it.each(fixtures.valid)("normalizes a safe plugin-relative path: $input", (fixture) => {
    expect(normalizePluginRelativePath(fixture.input)).toBe(fixture.normalized)
  })

  it("resolves only a validated relative path below the install root", () => {
    expect(resolvePluginPath("/plugins/example/", "./dist/index.js")).toBe(
      "/plugins/example/dist/index.js"
    )
    expect(() => resolvePluginPath("/plugins/example", "../outside.js")).toThrow(
      /plugin-relative path/i
    )
  })
})
