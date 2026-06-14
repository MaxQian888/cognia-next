import { computeConfigDefaults, seedPluginConfigDefaults } from "./config-defaults"
import type { PluginManifest } from "@/types/plugin"

const baseManifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "p",
  name: "P",
  version: "1.0.0",
  type: "frontend",
  capabilities: [],
  ...over,
})

describe("computeConfigDefaults", () => {
  it("returns {} for an undefined schema", () => {
    expect(computeConfigDefaults(undefined)).toEqual({})
  })

  it("collects per-property defaults, skipping properties without one", () => {
    const defaults = computeConfigDefaults({
      type: "object",
      properties: {
        a: { type: "string", default: "x" },
        b: { type: "number" },
        c: { type: "boolean", default: false },
      },
    })
    expect(defaults).toEqual({ a: "x", c: false })
  })
})

describe("seedPluginConfigDefaults", () => {
  it("seeds schema + defaultConfig values under unset keys only", () => {
    const manifest = baseManifest({
      defaultConfig: { token: "from-default-config" },
      configSchema: {
        type: "object",
        properties: {
          token: { type: "string", default: "from-schema" },
          retries: { type: "integer", default: 3 },
        },
      },
    })
    const result = seedPluginConfigDefaults(manifest, undefined)
    // defaultConfig wins over schema default for the same key.
    expect(result).toEqual({ token: "from-default-config", retries: 3 })
  })

  it("never overwrites a persisted user value", () => {
    const manifest = baseManifest({
      configSchema: { type: "object", properties: { retries: { type: "integer", default: 3 } } },
    })
    const result = seedPluginConfigDefaults(manifest, { retries: 9 })
    expect(result.retries).toBe(9)
  })

  it("returns the same reference when nothing needs seeding (no churn)", () => {
    const manifest = baseManifest({
      configSchema: { type: "object", properties: { a: { type: "string", default: "x" } } },
    })
    const current = { a: "kept" }
    expect(seedPluginConfigDefaults(manifest, current)).toBe(current)
  })

  it("returns the current object unchanged when there is no schema or defaultConfig", () => {
    const manifest = baseManifest()
    const current = { a: 1 }
    expect(seedPluginConfigDefaults(manifest, current)).toBe(current)
  })
})
