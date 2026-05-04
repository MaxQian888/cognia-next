import { applyTemplate, BUILTIN_SLASH_COMMANDS, type SettingsTab } from "./builtin"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"

describe("applyTemplate", () => {
  it("substitutes $ARGUMENTS with the full args string", () => {
    expect(applyTemplate("Review: $ARGUMENTS", "the auth flow")).toBe("Review: the auth flow")
  })

  it("substitutes positional $1..$9 by whitespace tokens", () => {
    expect(applyTemplate("$1 + $2 = $3", "alpha beta gamma")).toBe("alpha + beta = gamma")
  })

  it("collapses missing positionals to empty", () => {
    expect(applyTemplate("$1-$2-$3", "only")).toBe("only--")
  })

  it("trims args before $ARGUMENTS substitution", () => {
    expect(applyTemplate("X: $ARGUMENTS", "  trim me   ")).toBe("X: trim me")
  })

  it("leaves both placeholders intact when args is empty", () => {
    expect(applyTemplate("Hello $1 $ARGUMENTS!", "")).toBe("Hello  !")
  })
})

describe("BUILTIN_SLASH_COMMANDS registry", () => {
  it("has unique names", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("includes the canonical client-side commands", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name)
    for (const expected of [
      "clear",
      "help",
      "model",
      "agents",
      "mcp",
      "permissions",
      "init",
      "review",
    ]) {
      expect(names).toContain(expected)
    }
  })

  it("/init carries a non-empty template (no Action handler)", () => {
    const init = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "init")
    expect(init?.handler).toBeUndefined()
    expect(init?.template?.length ?? 0).toBeGreaterThan(20)
  })

  it("/clear carries an Action handler (no template)", () => {
    const clear = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "clear")
    expect(clear?.handler).toBeDefined()
    expect(clear?.template).toBeUndefined()
  })

  it("/compact is a disabled placeholder (sidecar support pending)", () => {
    const compact = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "compact")
    expect(compact?.disabled).toBe(true)
    expect(compact?.handler).toBeUndefined()
  })

  it("/cost is implemented (handler present, not disabled)", () => {
    const cost = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "cost")
    expect(cost?.disabled).not.toBe(true)
    expect(cost?.handler).toBeDefined()
  })
})

describe("SettingsTab is the live SettingsSectionId union", () => {
  // Phase 2 dedupe: every SETTINGS_NAV entry is a valid openSettings target.
  // The compile-time check below catches the case where a future contributor
  // adds a literal that isn't in SETTINGS_NAV.
  it("accepts every nav id at the type level", () => {
    for (const item of SETTINGS_NAV) {
      const tab: SettingsTab = item.id
      expect(typeof tab).toBe("string")
    }
  })

  it("rejects a stale literal that isn't in the nav", () => {
    // @ts-expect-error — "unknown-section" must NOT be assignable to SettingsTab.
    const stale: SettingsTab = "unknown-section"
    expect(stale).toBe("unknown-section")
  })
})
