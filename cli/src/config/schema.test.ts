import {
  CLI_LOGGING_DEFAULTS,
  cliConfigFileSchema,
  cliLoggingSchema,
  cliLogLevelRank,
  clipboardSchema,
  DEFAULT_COAUTHOR_TRAILER,
  DEFAULT_OSC52_MAX_BYTES,
  DEFAULT_PR_FOOTER,
  DEFAULT_RESOLVED_CONFIG,
  GIT_WORKFLOW_DEFAULTS,
  gitWorkflowSchema,
  NOTICE_DEFAULTS,
  noticesSchema,
  RENDER_DEFAULTS,
  resolveCliLoggingConfig,
  resolveGitWorkflowConfig,
  resolveNotices,
  resolveRenderConfig,
  renderConfigSchema,
  searchConfigSchema,
} from "./schema"

describe("renderConfigSchema + resolveRenderConfig", () => {
  it("returns the defaults when render is absent", () => {
    expect(resolveRenderConfig(undefined)).toEqual(RENDER_DEFAULTS)
  })

  it("overlays a sparse patch onto the defaults", () => {
    const r = resolveRenderConfig({ fileLineNumbers: false, toolResultMaxLines: 12 })
    expect(r.fileLineNumbers).toBe(false)
    expect(r.toolResultMaxLines).toBe(12)
    // Untouched fields keep their default.
    expect(r.syntaxHighlightInline).toBe(RENDER_DEFAULTS.syntaxHighlightInline)
  })

  it("ignores undefined-valued fields rather than clobbering a default", () => {
    const r = resolveRenderConfig({ fileLineNumbers: undefined })
    expect(r.fileLineNumbers).toBe(RENDER_DEFAULTS.fileLineNumbers)
  })

  it("rejects a fractional / out-of-range line count", () => {
    expect(renderConfigSchema.safeParse({ toolResultMaxLines: 1.5 }).success).toBe(false)
    expect(renderConfigSchema.safeParse({ pagerThresholdLines: 0 }).success).toBe(false)
    expect(renderConfigSchema.safeParse({ terminalResizeReplayMaxRows: -1 }).success).toBe(false)
  })

  it("defaults resize replay to 10,000 rows and accepts zero as unlimited", () => {
    expect(RENDER_DEFAULTS.terminalResizeReplayMaxRows).toBe(10_000)
    expect(
      resolveRenderConfig({ terminalResizeReplayMaxRows: 0 }).terminalResizeReplayMaxRows
    ).toBe(0)
  })

  it("accepts notices + clipboard on the config file", () => {
    const parsed = cliConfigFileSchema.safeParse({
      notices: { clipboardUnavailable: "no clip" },
      clipboard: { osc52: "always", osc52MaxBytes: 1000 },
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts render + keybindings on the config file", () => {
    const parsed = cliConfigFileSchema.safeParse({
      render: { collapseToolsByDefault: false },
      keybindings: { inspect: "ctrl+g" },
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a known layout and rejects an unknown one", () => {
    expect(cliConfigFileSchema.safeParse({ layout: "fullscreen" }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ layout: "scrollback" }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ layout: "windowed" }).success).toBe(false)
  })

  it("accepts an external-agent backend and defaults to builtin", () => {
    expect(cliConfigFileSchema.safeParse({ agentBackend: "claude-code" }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ agentBackend: "" }).success).toBe(false)
    expect(DEFAULT_RESOLVED_CONFIG.agentBackend).toBe("builtin")
  })
})

describe("cliConfigFileSchema.streamIdleTimeoutMs", () => {
  it("defaults to 60_000 in the resolved config", () => {
    expect(DEFAULT_RESOLVED_CONFIG.streamIdleTimeoutMs).toBe(60_000)
  })

  it("accepts a non-negative integer (0 disables)", () => {
    expect(cliConfigFileSchema.safeParse({ streamIdleTimeoutMs: 0 }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ streamIdleTimeoutMs: 120_000 }).success).toBe(true)
  })

  it("rejects a negative or fractional value", () => {
    expect(cliConfigFileSchema.safeParse({ streamIdleTimeoutMs: -1 }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ streamIdleTimeoutMs: 1.5 }).success).toBe(false)
  })
})

describe("cliConfigFileSchema.aiSdkMaxSteps", () => {
  it("defaults to 256 in the resolved config", () => {
    expect(DEFAULT_RESOLVED_CONFIG.aiSdkMaxSteps).toBe(256)
  })

  it("accepts a positive integer", () => {
    expect(cliConfigFileSchema.safeParse({ aiSdkMaxSteps: 1 }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ aiSdkMaxSteps: 1024 }).success).toBe(true)
  })

  it("rejects zero, negative, or fractional values", () => {
    expect(cliConfigFileSchema.safeParse({ aiSdkMaxSteps: 0 }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ aiSdkMaxSteps: -5 }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ aiSdkMaxSteps: 2.5 }).success).toBe(false)
  })
})

describe("cliConfigFileSchema.devPlugins", () => {
  it("accepts the dev-plugin flags", () => {
    expect(cliConfigFileSchema.safeParse({ devPlugins: true }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ devPluginsDir: "./plugins" }).success).toBe(true)
  })
  it("rejects a non-boolean devPlugins / empty devPluginsDir", () => {
    expect(cliConfigFileSchema.safeParse({ devPlugins: "yes" }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ devPluginsDir: "" }).success).toBe(false)
  })
  it("defaults to off (absent) in the resolved config", () => {
    expect(DEFAULT_RESOLVED_CONFIG.devPlugins).toBeUndefined()
  })
})

describe("cliConfigFileSchema.editor", () => {
  it("accepts the string sugar and the object form", () => {
    expect(cliConfigFileSchema.safeParse({ editor: "code" }).success).toBe(true)
    expect(
      cliConfigFileSchema.safeParse({ editor: { command: "subl", args: ["-n"] } }).success
    ).toBe(true)
    expect(
      cliConfigFileSchema.safeParse({ editor: { command: "myedit", gotoFormat: "vim" } }).success
    ).toBe(true)
  })

  it("rejects an empty string, unknown keys, and a bad gotoFormat", () => {
    expect(cliConfigFileSchema.safeParse({ editor: "" }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ editor: { bogus: 1 } }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ editor: { gotoFormat: "emacs" } }).success).toBe(false)
  })

  it("is absent by default in the resolved config", () => {
    expect(DEFAULT_RESOLVED_CONFIG.editor).toBeUndefined()
  })
})

describe("cliConfigFileSchema.toolExecutionTimeoutMs", () => {
  it("defaults to 120_000 in the resolved config", () => {
    expect(DEFAULT_RESOLVED_CONFIG.toolExecutionTimeoutMs).toBe(120_000)
  })

  it("accepts a non-negative integer (0 disables)", () => {
    expect(cliConfigFileSchema.safeParse({ toolExecutionTimeoutMs: 0 }).success).toBe(true)
    expect(cliConfigFileSchema.safeParse({ toolExecutionTimeoutMs: 300_000 }).success).toBe(true)
  })

  it("rejects a negative or fractional value", () => {
    expect(cliConfigFileSchema.safeParse({ toolExecutionTimeoutMs: -1 }).success).toBe(false)
    expect(cliConfigFileSchema.safeParse({ toolExecutionTimeoutMs: 1.5 }).success).toBe(false)
  })
})

/**
 * The CLI `customLimitsSources` schema must stay in sync with the canonical
 * `WindowSpec`/`DescriptorExtract` (`types/subscription/descriptor.ts`) and the
 * engine (`lib/subscription/limits/descriptor/engine.ts`). When the engine
 * gained count-based windows (`usedPath`/`totalPath`/`remainingPath`) and the
 * `select` array-element picker — so Coding Plan providers like MiniMax /
 * Kimi-coding can be expressed as config — the CLI schema has to accept the same
 * shapes, or a user's `config.json` carrying one fails to parse entirely.
 */
describe("cliConfigFileSchema.customLimitsSources", () => {
  it("parses a count-based (used/total) window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "mm",
          name: "MiniMax",
          baseUrl: "https://api.minimaxi.com",
          token: "tok",
          request: { path: "/v1/api/openplatform/coding_plan/remains" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                usedPath: "model_remains.0.current_interval_usage_count",
                totalPath: "model_remains.0.current_interval_total_count",
                resetAtPath: "model_remains.0.end_time",
                resetUnit: "unix",
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("parses a remaining/total window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "kc",
          name: "Kimi Coding",
          baseUrl: "https://api.kimi.com",
          token: "tok",
          request: { path: "/coding/v1/usages" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                remainingPath: "usage.remaining",
                totalPath: "usage.limit",
                resetAtPath: "usage.resetTime",
                resetUnit: "unix",
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("parses a `select` (discriminated-array) window source", () => {
    const parsed = cliConfigFileSchema.safeParse({
      customLimitsSources: [
        {
          id: "glm",
          name: "GLM",
          baseUrl: "https://api.z.ai",
          token: "raw-key",
          request: {
            path: "/api/monitor/usage/quota/limit",
            headers: { Authorization: "{{token}}" },
          },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "subscription.limits.meter.session",
                usedPctPath: "percentage",
                resetAtPath: "nextResetTime",
                resetUnit: "unix",
                select: {
                  arrayPath: "data.limits",
                  by: "TOKENS_LIMIT",
                  equals: "five_hour",
                },
              },
            ],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("preserves the count-based fields through parse (parity with the engine)", () => {
    const parsed = cliConfigFileSchema.parse({
      customLimitsSources: [
        {
          id: "mm",
          name: "MiniMax",
          baseUrl: "https://api.minimaxi.com",
          token: "tok",
          request: { path: "/r" },
          extract: {
            kind: "window",
            windows: [
              {
                id: "session",
                labelKey: "k",
                usedPath: "u",
                totalPath: "t",
                select: { arrayPath: "a.b", by: "tag", equals: "x" },
              },
            ],
          },
        },
      ],
    })
    const w = parsed.customLimitsSources![0].extract
    if (w.kind === "window") {
      expect(w.windows[0]).toMatchObject({
        usedPath: "u",
        totalPath: "t",
        select: { arrayPath: "a.b", by: "tag", equals: "x" },
      })
    }
  })
})

describe("noticesSchema + resolveNotices", () => {
  it("returns the defaults when notices are absent", () => {
    expect(resolveNotices(undefined)).toEqual(NOTICE_DEFAULTS)
  })

  it("overlays a sparse patch onto the defaults", () => {
    const n = resolveNotices({ clipboardUnavailable: "剪贴板不可用" })
    expect(n.clipboardUnavailable).toBe("剪贴板不可用")
    // Untouched keys keep their default wording.
    expect(n.copiedReply).toBe(NOTICE_DEFAULTS.copiedReply)
    expect(n.clipboardTooLarge).toBe(NOTICE_DEFAULTS.clipboardTooLarge)
  })

  it("ignores undefined-valued keys rather than clobbering a default", () => {
    const n = resolveNotices({ copiedCell: undefined })
    expect(n.copiedCell).toBe(NOTICE_DEFAULTS.copiedCell)
  })

  it("rejects an unknown notice key (strict)", () => {
    expect(noticesSchema.safeParse({ nope: "x" }).success).toBe(false)
  })
})

describe("clipboardSchema (osc52MaxBytes)", () => {
  it("defaults the OSC 52 byte cap to a terminal-safe value", () => {
    expect(DEFAULT_OSC52_MAX_BYTES).toBeGreaterThan(0)
  })

  it("accepts a non-negative integer cap (0 disables)", () => {
    expect(clipboardSchema.safeParse({ osc52MaxBytes: 0 }).success).toBe(true)
    expect(clipboardSchema.safeParse({ osc52MaxBytes: 100000 }).success).toBe(true)
  })

  it("rejects a negative or fractional cap", () => {
    expect(clipboardSchema.safeParse({ osc52MaxBytes: -1 }).success).toBe(false)
    expect(clipboardSchema.safeParse({ osc52MaxBytes: 1.5 }).success).toBe(false)
  })
})

describe("gitWorkflowSchema + resolveGitWorkflowConfig", () => {
  it("resolves the historic defaults when the section is absent", () => {
    expect(resolveGitWorkflowConfig(undefined)).toEqual(GIT_WORKFLOW_DEFAULTS)
    expect(GIT_WORKFLOW_DEFAULTS.protectedBranches).toEqual(["master", "main"])
    expect(GIT_WORKFLOW_DEFAULTS.coauthorTrailer).toBe(DEFAULT_COAUTHOR_TRAILER)
    expect(GIT_WORKFLOW_DEFAULTS.prFooter).toBe(DEFAULT_PR_FOOTER)
    expect(GIT_WORKFLOW_DEFAULTS.baseBranch).toBeNull()
  })

  it("false disables the trailer/footer; a string replaces it", () => {
    const r = resolveGitWorkflowConfig({
      coauthorTrailer: false,
      prFooter: "Custom footer",
    })
    expect(r.coauthorTrailer).toBeNull()
    expect(r.prFooter).toBe("Custom footer")
  })

  it("true keeps the default trailer/footer text", () => {
    const r = resolveGitWorkflowConfig({ coauthorTrailer: true, prFooter: true })
    expect(r.coauthorTrailer).toBe(DEFAULT_COAUTHOR_TRAILER)
    expect(r.prFooter).toBe(DEFAULT_PR_FOOTER)
  })

  it("carries protectedBranches and baseBranch overrides through", () => {
    const r = resolveGitWorkflowConfig({
      protectedBranches: ["master", "main", "dev"],
      baseBranch: "dev",
    })
    expect(r.protectedBranches).toEqual(["master", "main", "dev"])
    expect(r.baseBranch).toBe("dev")
  })

  it("rejects unknown keys and empty strings (strict)", () => {
    expect(gitWorkflowSchema.safeParse({ nope: true }).success).toBe(false)
    expect(gitWorkflowSchema.safeParse({ baseBranch: "" }).success).toBe(false)
    expect(gitWorkflowSchema.safeParse({ protectedBranches: [""] }).success).toBe(false)
  })

  it("is accepted as the top-level `git` key of the config file", () => {
    const parsed = cliConfigFileSchema.safeParse({
      git: { protectedBranches: ["main"], coauthorTrailer: false },
    })
    expect(parsed.success).toBe(true)
  })
})

describe("cliLoggingSchema + resolveCliLoggingConfig", () => {
  it("returns the defaults when logging is absent", () => {
    expect(resolveCliLoggingConfig(undefined)).toEqual(CLI_LOGGING_DEFAULTS)
  })

  it("overlays a sparse patch onto the defaults", () => {
    const r = resolveCliLoggingConfig({ fileLevel: "warn" })
    expect(r.fileLevel).toBe("warn")
    expect(r.mcpLogMaxKb).toBe(CLI_LOGGING_DEFAULTS.mcpLogMaxKb)
    expect(r.crashLogMaxKb).toBe(CLI_LOGGING_DEFAULTS.crashLogMaxKb)
  })

  it("accepts crashLogMaxKb 0 (never rotate) but rejects a sub-floor mcp size", () => {
    expect(cliLoggingSchema.safeParse({ crashLogMaxKb: 0 }).success).toBe(true)
    expect(cliLoggingSchema.safeParse({ mcpLogMaxKb: 8 }).success).toBe(false)
  })

  it("rejects unknown keys and unknown levels", () => {
    expect(cliLoggingSchema.safeParse({ bogus: true }).success).toBe(false)
    expect(cliLoggingSchema.safeParse({ fileLevel: "verbose" }).success).toBe(false)
  })

  it("is registered on the config-file schema", () => {
    const parsed = cliConfigFileSchema.safeParse({ logging: { fileLevel: "error" } })
    expect(parsed.success).toBe(true)
  })

  it("ranks levels debug < info < warn < error, with unknown ranked as info", () => {
    expect(cliLogLevelRank("debug")).toBeLessThan(cliLogLevelRank("info"))
    expect(cliLogLevelRank("info")).toBeLessThan(cliLogLevelRank("warn"))
    expect(cliLogLevelRank("warn")).toBeLessThan(cliLogLevelRank("error"))
    expect(cliLogLevelRank("notice")).toBe(cliLogLevelRank("info"))
  })
})

describe("searchConfigSchema", () => {
  it("accepts the ten supported search providers and defaults", () => {
    expect(
      searchConfigSchema.safeParse({
        defaultProvider: "brave",
        maxResults: 8,
        fallbackEnabled: true,
        safeSearch: "strict",
        providers: {
          brave: { enabled: true, priority: 1 },
          google: { enabled: true, priority: 2, cx: "engine-id" },
        },
      }).success
    ).toBe(true)
  })

  it("rejects unknown providers and invalid bounds", () => {
    expect(searchConfigSchema.safeParse({ providers: { duckduckgo: {} } }).success).toBe(false)
    expect(searchConfigSchema.safeParse({ maxResults: 0 }).success).toBe(false)
    expect(searchConfigSchema.safeParse({ safeSearch: "maximum" }).success).toBe(false)
  })
})
