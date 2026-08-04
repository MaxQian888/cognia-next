import type { PluginManifest } from "@/types/plugin"
import {
  assertPluginManifestParity,
  findPluginManifestParityIssues,
  PluginManifestParityError,
} from "./manifest-parity"

const base = (): PluginManifest => ({
  id: "example",
  name: "Example",
  version: "1.0.0",
  type: "frontend",
  main: "index.js",
})

describe("plugin manifest package parity", () => {
  it("accepts an exact packaged/module contribution match", () => {
    const packaged = {
      ...base(),
      subagents: [{ id: "reader", name: "Reader", description: "Reads", prompt: "Read carefully" }],
    }
    expect(findPluginManifestParityIssues(packaged, { ...packaged })).toEqual([])
  })

  it("ignores object key order when comparing serialized contributions", () => {
    const packaged = {
      ...base(),
      tools: [
        {
          name: "query_logs",
          description: "Query logs",
          parametersSchema: { type: "object", properties: { service: { type: "string" } } },
        },
      ],
    }
    const moduleManifest = {
      ...base(),
      tools: [
        {
          parametersSchema: { properties: { service: { type: "string" } }, type: "object" },
          description: "Query logs",
          name: "query_logs",
        },
      ],
    }
    expect(findPluginManifestParityIssues(packaged, moduleManifest)).toEqual([])
  })

  it("reports a contribution authored only in the module manifest", () => {
    const packaged = base()
    const moduleManifest = {
      ...base(),
      subagents: [{ id: "reader", name: "Reader", description: "Reads", prompt: "Read carefully" }],
    }

    expect(findPluginManifestParityIssues(packaged, moduleManifest)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "subagents" })])
    )
    expect(() => assertPluginManifestParity(packaged, moduleManifest)).toThrow(
      PluginManifestParityError
    )
    expect(() => assertPluginManifestParity(packaged, moduleManifest)).toThrow(/plugin\.json/)
  })

  it("reports a drifted module id", () => {
    expect(findPluginManifestParityIssues(base(), { ...base(), id: "other" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "id" })])
    )
  })

  it("allows activate-only modules that carry no separate manifest", () => {
    expect(() => assertPluginManifestParity(base(), undefined)).not.toThrow()
  })
})
