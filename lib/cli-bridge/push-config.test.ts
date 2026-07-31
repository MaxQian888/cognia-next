import {
  mergeCliConfig,
  projectAppConfigToCli,
  pushConfigToCli,
  type ConfigSettingsSlice,
} from "./push-config"

const FULL: ConfigSettingsSlice = {
  defaultProvider: "anthropic",
  defaultModel: "claude-opus-4-8",
  defaultSystemPrompt: "be terse",
  permissionMode: "acceptEdits",
  alwaysAllowTools: ["Read", "Grep"],
  builtinTools: {
    fileExtras: true,
    coreFiles: false,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
  },
  webTools: { enabled: true },
  selfInvokeTools: { skill: true, slashCommand: false },
  outputStyle: "concise",
}

describe("projectAppConfigToCli", () => {
  it("projects the owned subset with enum guards", () => {
    const out = projectAppConfigToCli(FULL)
    expect(out.provider).toBe("anthropic")
    expect(out.model).toBe("claude-opus-4-8")
    expect(out.systemPrompt).toBe("be terse")
    expect(out.permissionMode).toBe("acceptEdits")
    expect(out.allowedTools).toEqual(["Read", "Grep"])
    expect(out.builtinTools).toEqual({
      fileExtras: true,
      coreFiles: false,
      git: true,
      process: false,
      environment: true,
      shellAdvanced: false,
    })
    expect(out.webTools).toBe(true)
    expect(out.skillTool).toBe(true)
    expect(out.slashCommandTool).toBe(false)
    expect(out.outputStyle).toBe("concise")
  })

  it("omits empty / unset fields and rejects out-of-enum values", () => {
    const out = projectAppConfigToCli({
      alwaysAllowTools: [],
      permissionMode: "totally-invalid" as ConfigSettingsSlice["permissionMode"],
      outputStyle: "rainbow",
      defaultSystemPrompt: "   ",
    })
    expect(out).toEqual({})
  })

  it("treats webTools.enabled === false as a disabled flag", () => {
    expect(projectAppConfigToCli({ webTools: { enabled: false } }).webTools).toBe(false)
  })

  it("drops builtinTools entirely when no boolean keys are present", () => {
    expect(
      projectAppConfigToCli({ builtinTools: {} as ConfigSettingsSlice["builtinTools"] })
        .builtinTools
    ).toBeUndefined()
  })
})

describe("mergeCliConfig", () => {
  it("preserves unmanaged keys and overlays the subset", () => {
    const merged = mergeCliConfig(
      { theme: "dark", mascot: { style: "cat" }, model: "old" },
      { model: "new", provider: "anthropic" }
    )
    expect(merged).toEqual({
      theme: "dark",
      mascot: { style: "cat" },
      model: "new",
      provider: "anthropic",
    })
  })

  it("starts fresh when existing is not a plain object", () => {
    expect(mergeCliConfig(null, { model: "m" })).toEqual({ model: "m" })
    expect(mergeCliConfig([1, 2], { model: "m" })).toEqual({ model: "m" })
    expect(mergeCliConfig("nope", { model: "m" })).toEqual({ model: "m" })
  })
})

describe("pushConfigToCli", () => {
  it("returns false when there is no CLI home", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    const ok = await pushConfigToCli(FULL, { resolveHome: async () => null, write })
    expect(ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("read → patch → writes config.json preserving unknown keys", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    const read = jest.fn(async () => JSON.stringify({ theme: "dark", model: "old" }))
    const ok = await pushConfigToCli(FULL, {
      resolveHome: async () => "/home/.cognia",
      read,
      write,
      join: (h, f) => `${h}/${f}`,
    })
    expect(ok).toBe(true)
    expect(read).toHaveBeenCalledWith("/home/.cognia/config.json")
    const [fileName, content, secret] = write.mock.calls[0]
    expect(fileName).toBe("config.json")
    expect(secret).toBe(false)
    const parsed = JSON.parse(content)
    expect(parsed.theme).toBe("dark") // preserved
    expect(parsed.model).toBe("claude-opus-4-8") // overwritten
    expect(parsed.provider).toBe("anthropic")
  })

  it("treats an empty existing file as fresh and uses the default join", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    const read = jest.fn(async () => "")
    // No `join` injected → exercises defaultJoin.
    const ok = await pushConfigToCli(FULL, {
      resolveHome: async () => "/home/.cognia",
      read,
      write,
    })
    expect(ok).toBe(true)
    expect(read).toHaveBeenCalledWith("/home/.cognia/config.json")
    expect(JSON.parse(write.mock.calls[0][1]).model).toBe("claude-opus-4-8")
  })

  it("starts fresh when the existing config is missing or unparseable", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    const read = jest.fn(async () => {
      throw new Error("ENOENT")
    })
    const ok = await pushConfigToCli(FULL, {
      resolveHome: async () => "/home/.cognia",
      read,
      write,
    })
    expect(ok).toBe(true)
    const parsed = JSON.parse(write.mock.calls[0][1])
    expect(parsed.model).toBe("claude-opus-4-8")
  })
})
