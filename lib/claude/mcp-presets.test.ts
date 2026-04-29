import { applyPresetFields, getPreset, MCP_PRESETS } from "./mcp-presets"

describe("MCP_PRESETS catalog", () => {
  it("has unique IDs", () => {
    const ids = MCP_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has at least the canonical filesystem and github presets", () => {
    expect(getPreset("filesystem")).toBeDefined()
    expect(getPreset("github")).toBeDefined()
  })

  it("each field with placement=arg-replace declares a token", () => {
    for (const preset of MCP_PRESETS) {
      for (const field of preset.fields) {
        if (field.placement === "arg-replace") {
          expect(field.token).toBeTruthy()
        }
      }
    }
  })
})

describe("applyPresetFields", () => {
  it("substitutes arg-replace tokens", () => {
    const fs = getPreset("filesystem")!
    const config = applyPresetFields(fs, { PATH: "/Users/me/work" })
    expect(config.command).toBe("npx")
    expect(config.args as string[]).toContain("/Users/me/work")
    expect(config.args as string[]).not.toContain("<PATH>")
  })

  it("fills env vars", () => {
    const gh = getPreset("github")!
    const config = applyPresetFields(gh, {
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abc",
    })
    expect((config.env as Record<string, string>).GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_abc")
  })

  it("does not mutate the preset", () => {
    const fs = getPreset("filesystem")!
    const before = JSON.stringify(fs.config)
    applyPresetFields(fs, { PATH: "/x" })
    expect(JSON.stringify(fs.config)).toBe(before)
  })

  it("uses empty string when a value is missing", () => {
    const fs = getPreset("filesystem")!
    const config = applyPresetFields(fs, {})
    expect(config.args as string[]).toContain("")
  })
})
