import {
  settingsSections,
  cycleEnum,
  applyTargetDefault,
  type SettingsRow,
} from "./settings-sections"
import type { ResolvedConfig } from "../../config/schema"
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"
import { BUILTIN_TOOL_CONFIG_KEYS } from "@/lib/settings/builtin-tools"
import { externalCapabilities } from "./backend-capabilities"

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

describe("settingsSections — backend capability gating", () => {
  const rowsFor = (caps?: Parameters<typeof settingsSections>[1]) =>
    Object.fromEntries(
      settingsSections(cfg({ agentBackend: "codex" }), caps)
        .find((s) => s.id === "model")!
        .rows.map((r) => [r.id, r])
    )

  it("leaves every row live when no capabilities are supplied (built-in path)", () => {
    // An absent capability set must never disable the built-in path — that is
    // the default the whole TUI ran under before backends existed.
    const rows = rowsFor(undefined)
    expect(rows.model.unavailable).toBeUndefined()
    expect(rows.thinking.unavailable).toBeUndefined()
    expect(rows.subagentModels.unavailable).toBeUndefined()
  })

  it("marks rows the hosting agent cannot honour, with the reason", () => {
    const rows = rowsFor(externalCapabilities({ backend: "codex", presetId: "codex-app-server" }))
    // Codex forwards reasoning effort and can list its own models…
    expect(rows.thinking.unavailable).toBeUndefined()
    expect(rows.model.unavailable).toBeUndefined()
    // …but subagent model overrides are not forwarded to any external agent.
    expect(rows.subagentModels.unavailable).toMatch(/Subagent models is unavailable on codex/)
  })

  it("keeps the model row live on the ACP shim, which selects per session", () => {
    // The shim has no `model/list`, but ACP does have `session/set_model`, so
    // the picker has something real to drive. Blocking it here used to read as
    // "this agent cannot choose a model" when the truth was "this agent cannot
    // enumerate them without a session".
    const rows = rowsFor(externalCapabilities({ backend: "codex", presetId: "codex" }))
    expect(rows.model.unavailable).toBeUndefined()
    // Reasoning effort really is Codex-options-only, and the shim speaks ACP.
    expect(rows.thinking.unavailable).toMatch(/Thinking level is unavailable on codex/)
  })

  it("keeps the row visible rather than hiding it", () => {
    // Hiding would read as a missing feature; the row plus a reason explains.
    const rows = rowsFor(externalCapabilities({ backend: "claude-code" }))
    expect(rows.thinking).toBeDefined()
    expect(rows.thinking.label).toBe("Thinking level")
    expect(rows.thinking.unavailable).toMatch(/Thinking level is unavailable on claude-code/)
  })
})

describe("settingsSections", () => {
  it("returns the sections in a stable order", () => {
    expect(settingsSections(cfg()).map((s) => s.id)).toEqual([
      "model",
      "appearance",
      "display",
      "tools",
      "git",
      "behavior",
      "terminal",
      "logging",
      "advanced",
      "keybindings",
      "workspace",
    ])
  })

  it("gives every editable row a one-line description", () => {
    for (const section of settingsSections(cfg())) {
      for (const row of section.rows) {
        expect(typeof row.description).toBe("string")
        expect(row.description!.length).toBeGreaterThan(0)
      }
    }
  })

  it("exposes a credential editor for the active provider without revealing its secret", () => {
    const missing = findRow(cfg({ provider: "openai" }), "model", "credential")!
    expect(missing).toMatchObject({
      label: "Credential",
      value: "not configured",
      control: { type: "credential" },
    })

    const configured = findRow(
      cfg({ provider: "openai", providers: { openai: { apiKey: "sk-secret" } } }),
      "model",
      "credential"
    )!
    expect(configured.value).toBe("API key configured")
    expect(JSON.stringify(configured)).not.toContain("sk-secret")

    const tokenConfigured = findRow(
      cfg({ provider: "anthropic", providers: { anthropic: { authToken: "token-secret" } } }),
      "model",
      "credential"
    )!
    expect(tokenConfigured.value).toBe("token configured")
    expect(JSON.stringify(tokenConfigured)).not.toContain("token-secret")
  })

  it("renders every row with an explicitly-set (non-default) config value", () => {
    // Exercises the value-present side of each row's `?? default` fallback so the
    // panel model is proven against a fully-customized config, not just an empty one.
    const full = cfg({
      model: "gpt-4o",
      systemPrompt: "be terse",
      thinkingLevel: "high",
      subagentModels: { a: { model: "x" } },
      theme: "dark",
      outputStyle: "concise",
      statusBar: { theme: "vivid", segments: ["model", "cwd"] },
      mascot: { enabled: true, style: "cat" },
      render: { clickToExpand: true, toolResultMaxLines: 80, pagerThresholdLines: 500 },
      webTools: false,
      skillTool: true,
      skillLoadMode: "full",
      slashCommandTool: true,
      externalSkills: false,
      pluginTools: true,
      autoRoute: true,
      showActiveSkills: true,
      skillDirs: ["/a"],
      allowedTools: ["read"],
      builtinTools: { git: false },
      builtinHookOverrides: { "pii-safety-guard": true },
      layout: "scrollback",
      mouse: "select",
      terminalTitle: false,
      clipboard: { osc52: "always", osc52MaxBytes: 131072 },
      editor: { command: "code" },
      autoCompact: false,
      autoCompactThreshold: 0.9,
      streamIdleTimeoutMs: 120000,
      aiSdkMaxSteps: 512,
      toolExecutionTimeoutMs: 60000,
      subagentStreamIdleTimeoutMs: 600000,
      additionalRoots: ["/x"],
      customLimitsSources: [{ id: "s" } as never],
      keybindings: { inspect: "ctrl+j" },
    })
    const sections = settingsSections(full)
    expect(sections).toHaveLength(11)
    for (const section of sections) {
      for (const row of section.rows) {
        expect(row.value.length).toBeGreaterThan(0)
      }
    }
    // Spot-check a few value-present branches took effect.
    expect(
      sections.find((s) => s.id === "terminal")!.rows.find((r) => r.id === "mouse")!.value
    ).toBe("select")
    expect(
      sections.find((s) => s.id === "advanced")!.rows.find((r) => r.id === "autoCompact")!.control
    ).toMatchObject({ type: "boolean", current: false })
    expect(
      sections.find((s) => s.id === "workspace")!.rows.find((r) => r.id === "customLimits")!.value
    ).toBe("1 (edit in config.json)")
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
    const rows = settingsSections(cfg())[0].rows.filter((row) => row.control.type === "delegate")
    expect(rows.map((r) => (r.control as { command: string }).command)).toEqual([
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

  it("surfaces the render clickToExpand toggle in the Display section", () => {
    const row = findRow(cfg(), "display", "clickToExpand")!
    expect(row.control).toMatchObject({
      type: "boolean",
      current: false,
      apply: { kind: "render", key: "clickToExpand" },
    })
    const on = findRow(cfg({ render: { clickToExpand: true } }), "display", "clickToExpand")!
    expect((on.control as { current: boolean }).current).toBe(true)
  })

  it("exposes autoRoute / showActiveSkills flags in the Tools section", () => {
    const auto = findRow(cfg(), "tools", "autoRoute")!
    expect(auto.control).toMatchObject({
      type: "boolean",
      apply: { kind: "flag", key: "autoRoute" },
    })
    expect((auto.control as { current: boolean }).current).toBe(false)
    const skills = findRow(cfg({ showActiveSkills: true }), "tools", "showActiveSkills")!
    expect((skills.control as { current: boolean }).current).toBe(true)
  })

  it("delegates layout / mouse / editor to their commands and shows current values", () => {
    const terminal = settingsSections(
      cfg({ layout: "scrollback", editor: { command: "nvim" } })
    ).find((s) => s.id === "terminal")!
    const layout = terminal.rows.find((r) => r.id === "layout")!
    expect(layout.value).toBe("scrollback")
    expect((layout.control as { command: string }).command).toBe("/layout")
    const mouse = terminal.rows.find((r) => r.id === "mouse")!
    expect(mouse.value).toBe("scroll") // default
    expect((mouse.control as { command: string }).command).toBe("/mouse")
    const editor = terminal.rows.find((r) => r.id === "editor")!
    expect(editor.value).toBe("nvim")
    expect((editor.control as { command: string }).command).toBe("/editor")
  })

  it("defaults the editor row to auto-detect and the terminal-title flag to on", () => {
    const terminal = settingsSections(cfg()).find((s) => s.id === "terminal")!
    expect(terminal.rows.find((r) => r.id === "editor")!.value).toBe("auto-detect")
    const title = terminal.rows.find((r) => r.id === "terminalTitle")!
    expect((title.control as { current: boolean }).current).toBe(true)
    const off = settingsSections(cfg({ terminalTitle: false })).find((s) => s.id === "terminal")!
    expect(
      (off.rows.find((r) => r.id === "terminalTitle")!.control as { current: boolean }).current
    ).toBe(false)
  })

  it("exposes the clipboard OSC 52 mode + byte cap as enum rows", () => {
    const terminal = settingsSections(
      cfg({ clipboard: { osc52: "always", osc52MaxBytes: 131072 } })
    ).find((s) => s.id === "terminal")!
    const mode = terminal.rows.find((r) => r.id === "clipboardMode")!
    expect(mode.value).toBe("always")
    expect(mode.control).toMatchObject({ type: "enum", apply: { kind: "clipboard", key: "osc52" } })
    const cap = terminal.rows.find((r) => r.id === "clipboardMaxBytes")!
    expect(cap.value).toBe("131072")
    expect(cap.control).toMatchObject({
      type: "enum",
      apply: { kind: "clipboard", key: "osc52MaxBytes" },
    })
  })

  it("exposes the reliability numbers in the Advanced section (apply → numberValue)", () => {
    const advanced = settingsSections(cfg({ aiSdkMaxSteps: 512 })).find((s) => s.id === "advanced")!
    const steps = advanced.rows.find((r) => r.id === "aiSdkMaxSteps")!
    expect(steps.value).toBe("512")
    expect(steps.control).toMatchObject({
      type: "enum",
      apply: { kind: "numberValue", key: "aiSdkMaxSteps" },
    })
    // Falls back to the schema default when the key is unset.
    const idle = advanced.rows.find((r) => r.id === "streamIdleTimeoutMs")!
    expect(idle.value).toBe("60000")
    const autoCompact = advanced.rows.find((r) => r.id === "autoCompact")!
    expect((autoCompact.control as { current: boolean }).current).toBe(true)
    // Subagent nesting depth knob (default 2, editable as a numeric enum).
    const nesting = advanced.rows.find((r) => r.id === "subagentMaxDepth")!
    expect(nesting.value).toBe("2")
    expect(nesting.control).toMatchObject({
      type: "enum",
      apply: { kind: "numberValue", key: "subagentMaxDepth" },
    })
  })
})

describe("applyTargetDefault", () => {
  it("resets scalar/enum targets to their product default", () => {
    expect(typeof applyTargetDefault({ kind: "theme" })).toBe("string")
    expect(applyTargetDefault({ kind: "outputStyle" })).toBe("default")
    expect(applyTargetDefault({ kind: "statusTheme" })).toBe("default")
    expect(applyTargetDefault({ kind: "mascotEnabled" })).toBe(true)
    expect(applyTargetDefault({ kind: "mascotStyle" })).toBe("clawd")
    expect(applyTargetDefault({ kind: "configValue", key: "skillLoadMode" })).toBe("name")
  })

  it("resets boolean flags to the correct on/off default", () => {
    expect(applyTargetDefault({ kind: "flag", key: "webTools" })).toBe(true)
    expect(applyTargetDefault({ kind: "flag", key: "autoCompact" })).toBe(true)
    expect(applyTargetDefault({ kind: "flag", key: "terminalTitle" })).toBe(true)
    expect(applyTargetDefault({ kind: "flag", key: "skillTool" })).toBe(false)
    expect(applyTargetDefault({ kind: "flag", key: "showActiveSkills" })).toBe(false)
  })

  it("resets numeric + clipboard + render targets to their schema defaults", () => {
    expect(applyTargetDefault({ kind: "numberValue", key: "aiSdkMaxSteps" })).toBe("256")
    expect(applyTargetDefault({ kind: "numberValue", key: "streamIdleTimeoutMs" })).toBe("60000")
    expect(applyTargetDefault({ kind: "clipboard", key: "osc52" })).toBe("auto")
    expect(applyTargetDefault({ kind: "clipboard", key: "osc52MaxBytes" })).toBe("74994")
    expect(applyTargetDefault({ kind: "render", key: "toolResultMaxLines" })).toBe("40")
    expect(applyTargetDefault({ kind: "render", key: "collapseToolsByDefault" })).toBe(true)
  })

  it("resets a builtin tool / hook to its declared default", () => {
    expect(applyTargetDefault({ kind: "builtinTool", key: "git" })).toBe(true)
    expect(applyTargetDefault({ kind: "builtinTool", key: "lsp" })).toBe(false)
    expect(applyTargetDefault({ kind: "hook", id: "pii-safety-guard" })).toBe(false)
    expect(applyTargetDefault({ kind: "hook", id: "auto-context-loader" })).toBe(true)
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

describe("git section", () => {
  it("shows the defaults: master/main protected, trailer + footer on, auto base", () => {
    expect(findRow(cfg(), "git", "gitProtectedBranches")?.value).toBe("master main")
    expect(findRow(cfg(), "git", "gitBaseBranch")?.value).toContain("auto")
    expect(findRow(cfg(), "git", "gitCoauthorTrailer")?.value).toBe("on")
    expect(findRow(cfg(), "git", "gitPrFooter")?.value).toBe("on")
  })

  it("reflects config.git overrides, including a custom trailer string", () => {
    const c = cfg({
      git: {
        protectedBranches: ["master", "main", "dev"],
        baseBranch: "dev",
        coauthorTrailer: "Co-Authored-By: Bot <b@x>",
        prFooter: false,
      },
    })
    expect(findRow(c, "git", "gitProtectedBranches")?.value).toBe("master main dev")
    expect(findRow(c, "git", "gitBaseBranch")?.value).toBe("dev")
    expect(findRow(c, "git", "gitCoauthorTrailer")?.value).toBe("custom")
    expect(findRow(c, "git", "gitPrFooter")?.value).toBe("off")
  })

  it("wires the boolean rows to the gitWorkflow apply target", () => {
    const trailer = findRow(cfg(), "git", "gitCoauthorTrailer")
    expect(trailer?.control).toMatchObject({
      type: "boolean",
      current: true,
      apply: { kind: "gitWorkflow", key: "coauthorTrailer" },
    })
    const footer = findRow(cfg({ git: { prFooter: false } }), "git", "gitPrFooter")
    expect(footer?.control).toMatchObject({ type: "boolean", current: false })
  })

  it("wires branches/base to single-field forms", () => {
    expect(findRow(cfg(), "git", "gitProtectedBranches")?.control).toEqual({
      type: "form",
      field: "gitProtectedBranches",
    })
    expect(findRow(cfg(), "git", "gitBaseBranch")?.control).toEqual({
      type: "form",
      field: "gitBaseBranch",
    })
  })

  it("applyTargetDefault turns both git booleans back on", () => {
    expect(applyTargetDefault({ kind: "gitWorkflow", key: "coauthorTrailer" })).toBe(true)
    expect(applyTargetDefault({ kind: "gitWorkflow", key: "prFooter" })).toBe(true)
  })
})

describe("logging section", () => {
  it("shows resolved defaults for a config without a logging block", () => {
    expect(findRow(cfg(), "logging", "loggingFileLevel")?.value).toBe("info")
    expect(findRow(cfg(), "logging", "loggingMcpLogMaxKb")?.value).toBe("2048")
    expect(findRow(cfg(), "logging", "loggingCrashLogMaxKb")?.value).toBe("1024")
  })

  it("reflects configured values and renders crashLogMaxKb 0 as never", () => {
    const config = cfg({ logging: { fileLevel: "warn", crashLogMaxKb: 0 } })
    expect(findRow(config, "logging", "loggingFileLevel")?.value).toBe("warn")
    expect(findRow(config, "logging", "loggingCrashLogMaxKb")?.value).toBe("never")
  })

  it("wires enum rows to the logging apply target", () => {
    const row = findRow(cfg(), "logging", "loggingFileLevel")
    expect(row?.control).toMatchObject({
      type: "enum",
      apply: { kind: "logging", key: "fileLevel" },
    })
  })

  it("delegates the log viewer row to /mcp logs", () => {
    const row = findRow(cfg(), "logging", "loggingViewMcpLogs")
    expect(row?.control).toEqual({ type: "delegate", command: "/mcp logs" })
  })

  it("resets logging targets to their defaults", () => {
    expect(applyTargetDefault({ kind: "logging", key: "fileLevel" })).toBe("info")
    expect(applyTargetDefault({ kind: "logging", key: "mcpLogMaxKb" })).toBe("2048")
    expect(applyTargetDefault({ kind: "logging", key: "crashLogMaxKb" })).toBe("1024")
  })
})

describe("built-in tool rows cover the whole catalog", () => {
  it("offers a row for every switchable builtin-tool key", () => {
    // Four categories worked at runtime (the tool host gates on
    // `enabled[category]` generically) but had no row here and no entry in the
    // strict config schema, so there was no way to switch them on from the CLI.
    const rows = settingsSections(cfg()).flatMap((section) => section.rows.map((r) => r.id))
    const missing = BUILTIN_TOOL_CONFIG_KEYS.filter((key) => !rows.includes(`tool:${key}`))
    expect(missing).toEqual([])
  })
})

describe("label column budget", () => {
  // SettingsOverlay lays labels into a 34-column column and cuts anything wider,
  // so a label past the cap loses its tail on screen. The cut is a guard; a
  // shipped label reaching it is a regression in the label text, not the panel.
  const LABEL_COLUMN = 34

  it("keeps every shipped label inside the panel's label column", () => {
    const labels = settingsSections(cfg()).flatMap((s) => s.rows.map((r) => r.label))
    expect(labels.length).toBeGreaterThan(0)
    const tooWide = labels.filter((label) => label.length > LABEL_COLUMN)
    expect(tooWide).toEqual([])
  })
})
