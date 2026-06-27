import { settingsSections, cycleEnum, type SettingsRow } from "./settings-sections"
import type { ResolvedConfig } from "../../config/schema"
import type { BuiltinToolsConfig } from "@/lib/claude/types"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"

type CfgOver = Partial<Omit<ResolvedConfig, "builtinTools">> & {
  builtinTools?: Partial<BuiltinToolsConfig>
}

function cfg(over: CfgOver = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    permissionMode: "default",
    builtinTools: {},
    providers: {},
    cwd: "/work",
    ...over,
  } as ResolvedConfig
}

function findRow(
  config: ResolvedConfig,
  sectionId: string,
  rowId: string
): SettingsRow | undefined {
  return settingsSections(config)
    .find((s) => s.id === sectionId)
    ?.rows.find((r) => r.id === rowId)
}

describe("settingsSections", () => {
  it("returns the sections in a stable order", () => {
    expect(settingsSections(cfg()).map((s) => s.id)).toEqual([
      "model",
      "appearance",
      "display",
      "tools",
      "behavior",
      "keybindings",
      "workspace",
    ])
  })

  it("surfaces render prefs in the Display section (apply → render)", () => {
    const hl = findRow(cfg(), "display", "highlight")!
    expect(hl.control).toMatchObject({
      type: "boolean",
      apply: { kind: "render", key: "syntaxHighlightInline" },
    })
    const cap = findRow(cfg({ render: { toolResultMaxLines: 80 } }), "display", "maxLines")!
    expect(cap.value).toBe("80")
    expect(cap.control).toMatchObject({
      type: "enum",
      apply: { kind: "render", key: "toolResultMaxLines" },
    })
  })

  it("lists every keybinding read-only plus a rebind delegate", () => {
    const rows = settingsSections(cfg()).find((s) => s.id === "keybindings")!.rows
    const inspect = rows.find((r) => r.id === "key:inspect")!
    expect(inspect.value).toBe("Ctrl+G")
    expect(inspect.control.type).toBe("readonly")
    expect(rows.at(-1)).toMatchObject({
      id: "rebind",
      control: { type: "delegate", command: "/keybind" },
    })
  })

  it("reflects a custom keybinding override in the Display panel", () => {
    const rows = settingsSections(cfg({ keybindings: { inspect: "ctrl+j" } })).find(
      (s) => s.id === "keybindings"
    )!.rows
    expect(rows.find((r) => r.id === "key:inspect")!.value).toBe("Ctrl+J")
  })

  it("delegates provider/model/mode/thinking/subagent-models to existing commands", () => {
    const rows = settingsSections(cfg())[0].rows
    expect(rows.map((r) => (r.control as { command?: string }).command)).toEqual([
      "/provider",
      "/model",
      "/mode",
      "/think",
      "/agents models",
    ])
  })

  it("summarises the subagent-models row by override count", () => {
    expect(findRow(cfg(), "model", "subagentModels")!.value).toBe("inherit")
    const withOverrides = findRow(
      cfg({ subagentModels: { a: { model: "x" }, b: { model: "y" } } }),
      "model",
      "subagentModels"
    )!
    expect(withOverrides.value).toBe("2 overridden")
  })

  it("shows the current theme and offers an enum cycle over the theme choices", () => {
    const row = findRow(cfg({ theme: "dark" }), "appearance", "theme")!
    expect(row.value).toBe("dark")
    expect(row.control.type).toBe("enum")
    const ctrl = row.control as { options: string[]; current: string }
    expect(ctrl.current).toBe("dark")
    expect(ctrl.options).toContain("cognia")
    expect(ctrl.options).toContain("ansi")
    expect(ctrl.options).toContain("claude-code")
  })

  it("exposes a custom-theme form row", () => {
    const row = findRow(cfg({ theme: "custom:neon" }), "appearance", "custom-theme")!
    expect(row.control).toEqual({ type: "form", field: "customTheme" })
    expect(row.value).toBe("custom:neon")
  })

  it("treats webTools/externalSkills as on unless explicitly false", () => {
    const on = findRow(cfg(), "tools", "webTools")!
    expect((on.control as { current: boolean }).current).toBe(true)
    const off = findRow(cfg({ webTools: false }), "tools", "webTools")!
    expect((off.control as { current: boolean }).current).toBe(false)
  })

  it("treats skillTool/slashCommandTool/pluginTools as off unless explicitly true", () => {
    const row = findRow(cfg(), "tools", "skillTool")!
    expect((row.control as { current: boolean }).current).toBe(false)
    const on = findRow(cfg({ skillTool: true }), "tools", "skillTool")!
    expect((on.control as { current: boolean }).current).toBe(true)
  })

  it("exposes the skill load mode as an enum row defaulting to name-only", () => {
    const row = findRow(cfg(), "tools", "skillLoadMode")!
    const control = row.control as {
      type: string
      current: string
      options: string[]
      apply: { kind: string; key: string }
    }
    expect(control.type).toBe("enum")
    expect(control.current).toBe("name")
    expect(control.options).toEqual(["name", "full"])
    expect(control.apply).toEqual({ kind: "configValue", key: "skillLoadMode" })
    expect(row.value).toBe("name-only")
    const full = findRow(cfg({ skillLoadMode: "full" }), "tools", "skillLoadMode")!
    expect((full.control as { current: string }).current).toBe("full")
    expect(full.value).toBe("full bodies")
  })

  it("falls back to the product default for an unset builtin tool", () => {
    // git defaults true, lsp defaults false
    expect((findRow(cfg(), "tools", "tool:git")!.control as { current: boolean }).current).toBe(
      true
    )
    expect((findRow(cfg(), "tools", "tool:lsp")!.control as { current: boolean }).current).toBe(
      false
    )
  })

  it("honours an explicit builtin-tool override", () => {
    const row = findRow(cfg({ builtinTools: { git: false } }), "tools", "tool:git")!
    expect((row.control as { current: boolean }).current).toBe(false)
  })

  it("lists every built-in hook with its default/override state", () => {
    const behavior = settingsSections(cfg()).find((s) => s.id === "behavior")!
    const hookRows = behavior.rows.filter((r) => r.id.startsWith("hook:"))
    expect(hookRows).toHaveLength(BUILTIN_HOOKS.length)
    const piiDefault = BUILTIN_HOOKS.find((h) => h.id === "pii-safety-guard")!.defaultEnabled
    const row = findRow(cfg(), "behavior", "hook:pii-safety-guard")!
    expect((row.control as { current: boolean }).current).toBe(piiDefault)
    const overridden = findRow(
      cfg({ builtinHookOverrides: { "pii-safety-guard": true } }),
      "behavior",
      "hook:pii-safety-guard"
    )!
    expect((overridden.control as { current: boolean }).current).toBe(true)
  })

  it("renders the working dir read-only and additional roots as a delegate", () => {
    const ws = settingsSections(cfg({ additionalRoots: ["/a", "/b"] })).find(
      (s) => s.id === "workspace"
    )!
    expect(ws.rows.find((r) => r.id === "cwd")!.control.type).toBe("readonly")
    const roots = ws.rows.find((r) => r.id === "additionalRoots")!
    expect(roots.value).toBe("2 roots")
    expect((roots.control as { command: string }).command).toBe("/add-dir")
  })
})

describe("cycleEnum", () => {
  it("advances and wraps forward", () => {
    expect(cycleEnum(["a", "b", "c"], "a", 1)).toBe("b")
    expect(cycleEnum(["a", "b", "c"], "c", 1)).toBe("a")
  })
  it("advances and wraps backward", () => {
    expect(cycleEnum(["a", "b", "c"], "a", -1)).toBe("c")
  })
  it("starts from the first option when the current value is unknown", () => {
    expect(cycleEnum(["a", "b"], "zzz", 1)).toBe("b")
  })
  it("returns the current value for an empty option list", () => {
    expect(cycleEnum([], "x", 1)).toBe("x")
  })
})
