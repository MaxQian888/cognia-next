import {
  AUTHOR_CAPABILITY_CONTRACTS,
  CANONICAL_PLUGIN_CAPABILITIES,
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
  PLUGIN_PATH_FIELD_CONTRACTS,
} from "./catalog"

describe("canonical plugin author contract", () => {
  it.each([
    ["capabilities", CANONICAL_PLUGIN_CAPABILITIES],
    ["permissions", CANONICAL_PLUGIN_PERMISSIONS],
    ["plugin types", CANONICAL_PLUGIN_TYPES],
    ["path fields", PLUGIN_PATH_FIELD_CONTRACTS.map((entry) => entry.path)],
  ])("contains unique %s", (_label, values) => {
    expect(new Set(values).size).toBe(values.length)
  })

  it("describes every capability with a support policy", () => {
    expect(AUTHOR_CAPABILITY_CONTRACTS.length).toBeGreaterThan(0)
    expect(AUTHOR_CAPABILITY_CONTRACTS.every((entry) => entry.support.length > 0)).toBe(true)
  })

  it("assigns every capability an effective minimum host version", () => {
    expect(
      AUTHOR_CAPABILITY_CONTRACTS.every((entry) => /^\d+\.\d+\.\d+$/.test(entry.minimumHostVersion))
    ).toBe(true)
  })

  it("catalogs every confirmed JavaScript contribution entry", () => {
    expect(PLUGIN_PATH_FIELD_CONTRACTS.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "contextPanels[].entry",
        "sessionImporters[].entry",
        "externalAgentAdapters[].entry",
        "configComponent.entry",
      ])
    )
  })
})
