import {
  AUTHOR_CAPABILITY_CONTRACTS,
  CANONICAL_PLUGIN_CAPABILITIES,
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
  PLUGIN_PATH_FIELD_CONTRACTS,
  PLUGIN_MANIFEST_CONTRIBUTIONS,
  PLUGIN_RUNTIME_ENTRY_CONTRACTS,
  PLUGIN_CONTRACT_SCHEMA_VERSION,
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

  it("versions every capability explicitly in the versioned catalog", () => {
    expect(PLUGIN_CONTRACT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
    expect(
      AUTHOR_CAPABILITY_CONTRACTS.every(
        (entry) =>
          /^\d+\.\d+\.\d+$/.test(entry.introducedIn) &&
          /^\d+\.\d+\.\d+$/.test(entry.minimumHostVersion)
      )
    ).toBe(true)
  })

  it("describes every manifest contribution and its execution runtime", () => {
    const fields = PLUGIN_MANIFEST_CONTRIBUTIONS.map((entry) => entry.field)
    expect(new Set(fields).size).toBe(fields.length)
    expect(PLUGIN_MANIFEST_CONTRIBUTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "contextPanels",
          execution: "javascript",
          entryPath: "contextPanels[].entry",
        }),
        expect.objectContaining({ field: "sessionImporters", execution: "javascript" }),
      ])
    )
  })

  it("defines required and conditional runtime entries for every plugin type", () => {
    expect(Object.keys(PLUGIN_RUNTIME_ENTRY_CONTRACTS).sort()).toEqual(
      [...CANONICAL_PLUGIN_TYPES].sort()
    )
    expect(PLUGIN_RUNTIME_ENTRY_CONTRACTS.frontend.required).toContain("main")
    expect(PLUGIN_RUNTIME_ENTRY_CONTRACTS.python.required).toContain("pythonMain")
    expect(PLUGIN_RUNTIME_ENTRY_CONTRACTS.hybrid.javascriptEntry).toBe("main")
    expect(PLUGIN_RUNTIME_ENTRY_CONTRACTS.hybrid.javascriptEntryRequiredForContributions).toBe(true)
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
        "vscodeExtension.main",
        "vscodeExtension.browser",
        "vscodeExtension.contributes.grammars[].path",
        "vscodeExtension.contributes.chatInstructions[].path",
      ])
    )
  })
})
