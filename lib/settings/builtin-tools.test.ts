import {
  BUILTIN_SERVER_NAME,
  BUILTIN_SERVER_VERSION,
  BUILTIN_TOOL_CATEGORIES,
  getBuiltinToolCategory,
  listBuiltinTools,
  listNamespacedToolsInCategory,
  listToolNamesInCategory,
  namespaced,
  readOnlyBuiltinToolNames,
  type BuiltinToolCategoryId,
  type BuiltinToolRiskLevel,
} from "./builtin-tools"

describe("builtin-tools metadata", () => {
  it("exposes a stable server name and version", () => {
    expect(BUILTIN_SERVER_NAME).toBe("cognia-tools")
    expect(BUILTIN_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("derives the read-only tool surface from the approval metadata", () => {
    const readOnly = readOnlyBuiltinToolNames()
    const expected = listBuiltinTools()
      .filter((t) => !t.requiresApproval)
      .map((t) => namespaced(t.name))
    expect(readOnly).toEqual(expected)
    // Every name is SDK-namespaced, and no approval-required tool leaks in.
    expect(readOnly.every((n) => n.startsWith(`mcp__${BUILTIN_SERVER_NAME}__`))).toBe(true)
    const approvalRequired = new Set(
      listBuiltinTools()
        .filter((t) => t.requiresApproval)
        .map((t) => namespaced(t.name))
    )
    expect(readOnly.some((n) => approvalRequired.has(n))).toBe(false)
    expect(readOnly.length).toBeGreaterThan(0)
  })

  it("registers all expected categories", () => {
    const ids = BUILTIN_TOOL_CATEGORIES.map((c) => c.id)
    expect(ids.sort()).toEqual(
      [
        "astGrep",
        "codeGraph",
        "coreFiles",
        "dependencyResearch",
        "environment",
        "fileExtras",
        "git",
        "lsp",
        "process",
        "shellAdvanced",
        "terminalRepl",
        "webclone",
      ].sort()
    )
  })

  it("namespaced() prefixes with the server name", () => {
    expect(namespaced("file_hash")).toBe("mcp__cognia-tools__file_hash")
  })

  it("never reuses the same bare tool name across categories", () => {
    const seen = new Set<string>()
    for (const tool of listBuiltinTools()) {
      expect(seen.has(tool.name)).toBe(false)
      seen.add(tool.name)
    }
  })

  it("never duplicates SDK built-ins (Bash, Read, Write, Edit, Glob, Grep, …)", () => {
    const sdkBuiltIns = [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "file_read",
      "file_write",
      "shell_execute",
    ]
    // The `coreFiles` suite intentionally mirrors SDK built-in names (TodoWrite,
    // NotebookEdit, …) — it's namespaced and default-OFF on the Anthropic path,
    // so no real collision occurs (same carve-out as the sidecar index test).
    const ourNames = new Set(
      BUILTIN_TOOL_CATEGORIES.filter((c) => c.id !== "coreFiles").flatMap((c) =>
        c.tools.map((t) => t.name)
      )
    )
    for (const sdkName of sdkBuiltIns) {
      expect(ourNames.has(sdkName)).toBe(false)
    }
  })

  it.each(["low", "medium", "high"] satisfies BuiltinToolRiskLevel[])(
    "accepts %s as a valid risk level",
    (level) => {
      const allLevels = listBuiltinTools().map((t) => t.riskLevel)
      expect(allLevels).toContain(level)
    }
  )

  it("every tool has a description i18n key", () => {
    for (const tool of listBuiltinTools()) {
      expect(tool.descriptionKey).toMatch(/^tools\.[a-zA-Z]+$/)
    }
  })

  it("requiresApproval is consistent: high risk implies approval", () => {
    for (const tool of listBuiltinTools()) {
      if (tool.riskLevel === "high") {
        expect(tool.requiresApproval).toBe(true)
      }
    }
  })

  it("alwaysLoad tools are never the ones that require approval", () => {
    // alwaysLoad means the SDK keeps the schema in the prompt; that's only
    // safe for low-risk read-only ops. If we ever set alwaysLoad on an
    // approval-gated tool, the agent would see it in every system prompt
    // and the user would face approval requests for things they didn't ask for.
    for (const tool of listBuiltinTools()) {
      if (tool.alwaysLoad) {
        expect(tool.requiresApproval).toBe(false)
      }
    }
  })

  it("getBuiltinToolCategory returns undefined for unknown ids", () => {
    expect(getBuiltinToolCategory("does-not-exist")).toBeUndefined()
  })

  it("getBuiltinToolCategory returns the right shape for known ids", () => {
    const cat = getBuiltinToolCategory("fileExtras")
    expect(cat?.id).toBe("fileExtras")
    expect(cat?.desktopOnly).toBe(true)
    expect(cat?.tools.length).toBeGreaterThan(0)
  })

  it("listToolNamesInCategory mirrors the category contents", () => {
    const ids: BuiltinToolCategoryId[] = [
      "fileExtras",
      "git",
      "process",
      "environment",
      "shellAdvanced",
      "terminalRepl",
      "lsp",
    ]
    for (const id of ids) {
      const names = listToolNamesInCategory(id)
      expect(names.length).toBeGreaterThan(0)
      expect(names).toEqual(getBuiltinToolCategory(id)?.tools.map((t) => t.name))
    }
  })

  it("listToolNamesInCategory returns [] for unknown category ids", () => {
    expect(listToolNamesInCategory("nope" as BuiltinToolCategoryId)).toEqual([])
  })

  it("listNamespacedToolsInCategory adds the mcp__cognia-tools__ prefix", () => {
    const ns = listNamespacedToolsInCategory("git")
    expect(ns.every((n) => n.startsWith("mcp__cognia-tools__"))).toBe(true)
  })

  it("every category is desktopOnly (the sidecar is desktop-only by design)", () => {
    for (const cat of BUILTIN_TOOL_CATEGORIES) {
      expect(cat.desktopOnly).toBe(true)
    }
  })

  it("category.requiresApproval is true if any tool in it requires approval", () => {
    for (const cat of BUILTIN_TOOL_CATEGORIES) {
      const anyToolNeedsApproval = cat.tools.some((t) => t.requiresApproval)
      if (anyToolNeedsApproval) {
        expect(cat.requiresApproval).toBe(true)
      }
    }
  })

  it("listBuiltinTools is the flat union of all categories", () => {
    const flatCount = BUILTIN_TOOL_CATEGORIES.reduce((acc, c) => acc + c.tools.length, 0)
    expect(listBuiltinTools()).toHaveLength(flatCount)
  })
})
