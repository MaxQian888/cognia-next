const builtinTools = {
  listBuiltinTools: jest.fn(() => [] as { name: string }[]),
  namespaced: (name: string) => `mcp__cognia-tools__${name}`,
}
jest.mock("@/lib/settings/builtin-tools", () => ({
  listBuiltinTools: () => builtinTools.listBuiltinTools(),
  namespaced: (name: string) => builtinTools.namespaced(name),
}))

const getPluginManager = jest.fn(() => null as unknown)
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => getPluginManager(),
}))

import {
  collectRegisteredToolNames,
  intersectAllowedTools,
  SDK_CORE_TOOL_NAMES,
} from "./tool-catalog"

describe("intersectAllowedTools", () => {
  const catalog = ["Read", "Bash", "mcp__cognia-tools__file_hash"]

  it("keeps only names that exist", () => {
    const result = intersectAllowedTools(["Read", "Teleport"], catalog)
    expect(result.kept).toEqual(["Read"])
    expect(result.unknown).toEqual(["Teleport"])
  })

  it("keeps a namespaced MCP tool", () => {
    expect(intersectAllowedTools(["mcp__cognia-tools__file_hash"], catalog).kept).toEqual([
      "mcp__cognia-tools__file_hash",
    ])
  })

  /**
   * The one case where trusting the proposal would be worst. An empty catalog
   * means "we could not enumerate tools", not "these are fine" — and a skill
   * declaring a tool that does not exist is inert while looking authoritative.
   */
  it("reports everything unknown when the catalog is empty", () => {
    const result = intersectAllowedTools(["Read", "Bash"], [])
    expect(result.kept).toEqual([])
    expect(result.unknown).toEqual(["Read", "Bash"])
  })

  it("drops blanks and de-duplicates", () => {
    const result = intersectAllowedTools(["Read", " ", "Read", "", "Read"], catalog)
    expect(result.kept).toEqual(["Read"])
    expect(result.unknown).toEqual([])
  })

  it("trims surrounding whitespace before matching", () => {
    expect(intersectAllowedTools(["  Read  "], catalog).kept).toEqual(["Read"])
  })

  it("reports an empty proposal as nothing kept and nothing unknown", () => {
    const result = intersectAllowedTools([], catalog)
    expect(result.kept).toEqual([])
    expect(result.unknown).toEqual([])
    expect(result.available).toEqual(catalog)
  })

  it("surfaces the full catalog for the confirmation UI", () => {
    expect(intersectAllowedTools(["Read"], catalog).available).toEqual(catalog)
  })
})

describe("SDK_CORE_TOOL_NAMES", () => {
  it("covers the tools the agent SDK provides itself", () => {
    // These exist nowhere at runtime — the SDK owns them — so they have to be
    // enumerated or every skill that uses Read/Write/Bash would report unknown.
    for (const name of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"]) {
      expect(SDK_CORE_TOOL_NAMES).toContain(name)
    }
  })

  it("has no duplicates", () => {
    expect(new Set(SDK_CORE_TOOL_NAMES).size).toBe(SDK_CORE_TOOL_NAMES.length)
  })
})

describe("collectRegisteredToolNames", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    builtinTools.listBuiltinTools.mockReturnValue([])
    getPluginManager.mockReturnValue(null)
  })

  it("always includes the SDK's own tools", async () => {
    // They exist nowhere at runtime — the SDK owns them — so without this every
    // skill that uses Read or Bash would report unknown.
    const names = await collectRegisteredToolNames()
    for (const name of SDK_CORE_TOOL_NAMES) expect(names).toContain(name)
  })

  it("namespaces the sidecar's builtin tools", async () => {
    builtinTools.listBuiltinTools.mockReturnValue([{ name: "file_hash" }])
    await expect(collectRegisteredToolNames()).resolves.toContain("mcp__cognia-tools__file_hash")
  })

  it("includes tools registered by plugins", async () => {
    getPluginManager.mockReturnValue({
      getRegistry: () => ({ getAllTools: () => [{ name: "acme__lookup" }, { name: "" }, null] }),
    })
    const names = await collectRegisteredToolNames()
    expect(names).toContain("acme__lookup")
    // A nameless entry is skipped rather than added as an empty string.
    expect(names).not.toContain("")
  })

  it("survives a plugin runtime that is not initialized on this surface", async () => {
    getPluginManager.mockReturnValue({ getRegistry: () => undefined })
    await expect(collectRegisteredToolNames()).resolves.toContain("Read")
  })

  it("narrows the catalog rather than failing when a source throws", async () => {
    // A failure here must not break generation — it makes the intersection
    // stricter, which is the safe direction.
    builtinTools.listBuiltinTools.mockImplementation(() => {
      throw new Error("no sidecar")
    })
    getPluginManager.mockImplementation(() => {
      throw new Error("no plugins")
    })
    const names = await collectRegisteredToolNames()
    expect(names).toEqual([...SDK_CORE_TOOL_NAMES].sort())
  })

  it("de-duplicates and sorts", async () => {
    builtinTools.listBuiltinTools.mockReturnValue([{ name: "b" }, { name: "b" }])
    const names = await collectRegisteredToolNames()
    expect(new Set(names).size).toBe(names.length)
    expect([...names]).toEqual([...names].sort())
  })
})
