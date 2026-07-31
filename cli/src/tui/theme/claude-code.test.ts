import { readClaudeCodeTheme } from "./claude-code"

/** Build a fake reader over a path→content map. Missing paths return null. */
function reader(files: Record<string, string>) {
  return (p: string) => {
    const norm = p.replace(/\\/g, "/")
    for (const [k, v] of Object.entries(files)) {
      if (norm.endsWith(k)) return v
    }
    return null
  }
}

const HOME = "/home/u"

describe("readClaudeCodeTheme", () => {
  it("returns null when Claude Code has no settings file", () => {
    expect(readClaudeCodeTheme({ osHome: HOME, read: reader({}) })).toBeNull()
  })

  it("returns null when settings.json has no theme key", () => {
    const read = reader({ ".claude/settings.json": JSON.stringify({ model: "opus" }) })
    expect(readClaudeCodeTheme({ osHome: HOME, read })).toBeNull()
  })

  it("maps the built-in 'dark' theme to a Claude-flavoured dark palette (brand accent)", () => {
    const read = reader({ ".claude/settings.json": JSON.stringify({ theme: "dark" }) })
    const p = readClaudeCodeTheme({ osHome: HOME, read })
    expect(p).not.toBeNull()
    expect(p!.accent.toLowerCase()).toBe("#d77757") // documented Claude brand
    expect(p!.border.toLowerCase()).toBe("#d77757") // border derives from accent
  })

  it("maps 'light' to a light palette with the documented light success/error", () => {
    const read = reader({ ".claude/settings.json": JSON.stringify({ theme: "light" }) })
    const p = readClaudeCodeTheme({ osHome: HOME, read })!
    expect(p.success.toLowerCase()).toBe("#2c7a39")
    expect(p.danger.toLowerCase()).toBe("#ab2b3f")
  })

  it("maps ansi variants to the classic ANSI palette", () => {
    const read = reader({ ".claude/settings.json": JSON.stringify({ theme: "dark-ansi" }) })
    const p = readClaudeCodeTheme({ osHome: HOME, read })!
    expect(p.accent).toBe("cyan")
  })

  it("reads a custom theme's base + overrides and maps Claude tokens to ours", () => {
    const read = reader({
      ".claude/settings.json": JSON.stringify({ theme: "custom:dracula" }),
      ".claude/themes/dracula.json": JSON.stringify({
        name: "Dracula",
        base: "dark",
        overrides: {
          claude: "#bd93f9", // → accent
          error: "#ff5555", // → danger
          success: "#50fa7b", // → success
          diffAdded: "rgb(80, 250, 123)", // → diffAdded (element token)
          subtle: "ansi:gray", // → muted
          bogusToken: "#123456", // ignored
        },
      }),
    })
    const p = readClaudeCodeTheme({ osHome: HOME, read })!
    expect(p.accent.toLowerCase()).toBe("#bd93f9")
    expect(p.heading1.toLowerCase()).toBe("#bd93f9") // derived from overridden accent
    expect(p.danger.toLowerCase()).toBe("#ff5555")
    expect(p.success.toLowerCase()).toBe("#50fa7b")
    expect(p.diffAdded.toLowerCase()).toBe("#50fa7b")
    expect(p.muted).toBe("gray")
  })

  it("ignores invalid override colours and keeps the derived default", () => {
    const read = reader({
      ".claude/settings.json": JSON.stringify({ theme: "custom:x" }),
      ".claude/themes/x.json": JSON.stringify({ overrides: { claude: "not-a-color" } }),
    })
    const p = readClaudeCodeTheme({ osHome: HOME, read })!
    // claude override was unparseable → accent stays the base "dark" claude brand
    expect(p.accent.toLowerCase()).toBe("#d77757")
  })

  it("survives a malformed settings.json without throwing", () => {
    const read = reader({ ".claude/settings.json": "{ not json" })
    expect(readClaudeCodeTheme({ osHome: HOME, read })).toBeNull()
  })

  it("falls back to a dark claude look when a custom file is missing", () => {
    const read = reader({ ".claude/settings.json": JSON.stringify({ theme: "custom:gone" }) })
    const p = readClaudeCodeTheme({ osHome: HOME, read })!
    expect(p.accent.toLowerCase()).toBe("#d77757")
  })
})
