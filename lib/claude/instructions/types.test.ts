import { resolveInstructionsConfig, DEFAULT_INSTRUCTION_FILE_NAMES } from "./types"

describe("resolveInstructionsConfig", () => {
  it("fills every field with a default when given nothing", () => {
    expect(resolveInstructionsConfig()).toEqual({
      enabled: true,
      mode: "layered",
      includeGlobal: true,
      globalPath: undefined,
      fileNames: DEFAULT_INSTRUCTION_FILE_NAMES,
      extraPaths: [],
      maxFileBytes: 64_000,
      maxFiles: 50,
      maxImportDepth: 5,
      loadProjectAgents: true,
    })
  })

  it("honours explicit overrides", () => {
    const r = resolveInstructionsConfig({
      enabled: false,
      mode: "nearest",
      includeGlobal: false,
      globalPath: "  /g/AGENTS.md  ",
      fileNames: [" RULES.md ", ""],
      extraPaths: [" a.md ", ""],
      maxFileBytes: 10,
      maxFiles: 2,
      maxImportDepth: 0,
      loadProjectAgents: false,
    })
    expect(r.mode).toBe("nearest")
    expect(r.globalPath).toBe("/g/AGENTS.md")
    expect(r.fileNames).toEqual(["RULES.md"])
    expect(r.extraPaths).toEqual(["a.md"])
    expect(r.maxImportDepth).toBe(0)
    expect(r.loadProjectAgents).toBe(false)
  })

  it("falls back to default filenames when the override is all-blank", () => {
    expect(resolveInstructionsConfig({ fileNames: ["  ", ""] }).fileNames).toEqual(
      DEFAULT_INSTRUCTION_FILE_NAMES
    )
  })

  it("rejects non-positive numeric overrides", () => {
    const r = resolveInstructionsConfig({ maxFileBytes: 0, maxFiles: -1, maxImportDepth: -1 })
    expect(r.maxFileBytes).toBe(64_000)
    expect(r.maxFiles).toBe(50)
    expect(r.maxImportDepth).toBe(5)
  })

  it("blank explicit global path resolves to undefined", () => {
    expect(resolveInstructionsConfig({ globalPath: "   " }).globalPath).toBeUndefined()
  })
})
