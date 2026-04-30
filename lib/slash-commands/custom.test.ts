import { invoke } from "@tauri-apps/api/core"
import { loadCustomSlashCommands, applyTemplate } from "./custom"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
})

describe("loadCustomSlashCommands", () => {
  it("returns [] and logs at debug when invoke throws", async () => {
    const consoleSpy = jest.spyOn(console, "debug").mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(new Error("not Tauri"))
    const out = await loadCustomSlashCommands(null)
    expect(out).toEqual([])
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it("converts each raw row into a SlashCommand", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "deploy",
        scope: "project",
        path: "/proj/.claude/commands/deploy.md",
        description: "Deploy the app",
        argumentHint: "<env>",
        allowedTools: ["bash"],
        model: "claude-3-opus",
        paths: ["/p"],
        disableModelInvocation: null,
        userInvocable: null,
        body: "deploy to $1",
      },
    ])
    const out = await loadCustomSlashCommands("/proj")
    expect(mockedInvoke).toHaveBeenCalledWith("slash_commands_scan", { cwd: "/proj" })
    expect(out).toEqual([
      {
        name: "deploy",
        description: "Deploy the app",
        scope: "project",
        argumentHint: "<env>",
        template: "deploy to $1",
        filePath: "/proj/.claude/commands/deploy.md",
        model: "claude-3-opus",
        allowedTools: ["bash"],
        paths: ["/p"],
        hiddenFromPicker: false,
      },
    ])
  })

  it("falls back to user scope and (custom command) description for unknown scope/null fields", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "x",
        scope: "unrecognised",
        path: "/p",
        description: null,
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: null,
        body: "body",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].scope).toBe("user")
    expect(out[0].description).toBe("(custom command)")
    expect(out[0].argumentHint).toBeUndefined()
    expect(out[0].allowedTools).toBeUndefined()
    expect(out[0].model).toBeUndefined()
    expect(out[0].paths).toBeUndefined()
    expect(out[0].hiddenFromPicker).toBe(false)
  })

  it("preserves explicit user scope mapping", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "u",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: null,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(undefined)
    expect(out[0].scope).toBe("user")
  })

  it("hides commands when userInvocable is false", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "h",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: false,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].hiddenFromPicker).toBe(true)
  })

  it("hides commands when disableModelInvocation is true", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "h",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: true,
        userInvocable: null,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].hiddenFromPicker).toBe(true)
  })
})

describe("custom re-exports applyTemplate", () => {
  it("re-exports the same applyTemplate", () => {
    expect(applyTemplate("$1", "x")).toBe("x")
  })
})
