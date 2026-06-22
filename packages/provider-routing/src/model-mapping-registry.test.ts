import {
  addMapping,
  createMappingRegistry,
  findMappingByAlias,
  listAliases,
  removeMapping,
  updateMapping,
} from "./model-mapping-registry"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"

function mapping(id: string, alias: string): ModelMapping {
  return {
    id,
    alias,
    providers: [{ providerId: "openai", modelId: "gpt-4o" }],
    distribution: "priority",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("createMappingRegistry", () => {
  it("starts globally enabled and copies the input mappings", () => {
    const input = [mapping("m1", "fast")]
    const reg = createMappingRegistry(input)
    expect(reg.enabled).toBe(true)
    expect(reg.mappings).toEqual(input)
    expect(reg.mappings).not.toBe(input)
  })

  it("accepts an empty list", () => {
    const reg = createMappingRegistry([])
    expect(reg.mappings).toEqual([])
    expect(reg.enabled).toBe(true)
  })
})

describe("findMappingByAlias", () => {
  const reg = createMappingRegistry([mapping("m1", "Fast"), mapping("m2", "balanced")])

  it("matches case-insensitively", () => {
    expect(findMappingByAlias(reg, "fast")?.id).toBe("m1")
    expect(findMappingByAlias(reg, "FAST")?.id).toBe("m1")
    expect(findMappingByAlias(reg, "Balanced")?.id).toBe("m2")
  })

  it("returns undefined for unknown aliases", () => {
    expect(findMappingByAlias(reg, "missing")).toBeUndefined()
  })
})

describe("listAliases", () => {
  it("returns aliases in their original case and order", () => {
    const reg = createMappingRegistry([
      mapping("a", "Fast"),
      mapping("b", "balanced"),
      mapping("c", "Coding"),
    ])
    expect(listAliases(reg)).toEqual(["Fast", "balanced", "Coding"])
  })

  it("returns an empty list for an empty registry", () => {
    expect(listAliases(createMappingRegistry([]))).toEqual([])
  })
})

describe("addMapping / removeMapping / updateMapping", () => {
  it("addMapping appends and is immutable", () => {
    const reg = createMappingRegistry([mapping("m1", "fast")])
    const next = addMapping(reg, mapping("m2", "balanced"))
    expect(next).not.toBe(reg)
    expect(next.mappings).not.toBe(reg.mappings)
    expect(reg.mappings).toHaveLength(1)
    expect(next.mappings.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("removeMapping drops the matching id and is immutable", () => {
    const reg = createMappingRegistry([mapping("m1", "fast"), mapping("m2", "balanced")])
    const next = removeMapping(reg, "m1")
    expect(next).not.toBe(reg)
    expect(reg.mappings).toHaveLength(2)
    expect(next.mappings.map((m) => m.id)).toEqual(["m2"])
  })

  it("removeMapping returns a fresh registry even when the id is unknown", () => {
    const reg = createMappingRegistry([mapping("m1", "fast")])
    const next = removeMapping(reg, "missing")
    expect(next).not.toBe(reg)
    expect(next.mappings).toEqual(reg.mappings)
  })

  it("updateMapping replaces by id and is immutable", () => {
    const reg = createMappingRegistry([mapping("m1", "fast"), mapping("m2", "balanced")])
    const replacement: ModelMapping = {
      ...mapping("m1", "fast"),
      enabled: false,
      updatedAt: 999,
    }
    const next = updateMapping(reg, replacement)
    expect(next).not.toBe(reg)
    expect(next.mappings[0]).toEqual(replacement)
    expect(reg.mappings[0].enabled).toBe(true) // original untouched
  })

  it("updateMapping is a no-op when no mapping has that id", () => {
    const reg = createMappingRegistry([mapping("m1", "fast")])
    const next = updateMapping(reg, mapping("missing", "new"))
    expect(next.mappings).toEqual(reg.mappings)
    // Reference is still fresh (immutable contract).
    expect(next).not.toBe(reg)
  })

  it("preserves the global enabled flag across mutations", () => {
    const reg = { ...createMappingRegistry([mapping("m1", "fast")]), enabled: false }
    expect(addMapping(reg, mapping("m2", "balanced")).enabled).toBe(false)
    expect(removeMapping(reg, "m1").enabled).toBe(false)
    expect(updateMapping(reg, mapping("m1", "fast")).enabled).toBe(false)
  })
})
