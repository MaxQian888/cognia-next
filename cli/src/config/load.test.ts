/**
 * @jest-environment node
 */
import path from "node:path"

import {
  resolveConfig,
  userConfigPath,
  credentialsPath,
  projectConfigPath,
  resolveHome,
  type FileReader,
} from "./load"

const HOME = "/home/u/.cognia"
const CWD = "/work/project"

/** Build an injected reader from a path→content map. */
function reader(files: Record<string, string>): FileReader {
  return (p) => (p in files ? files[p] : null)
}

function run(
  files: Record<string, string>,
  opts: { env?: Record<string, string | undefined>; flags?: Record<string, unknown> } = {}
) {
  return resolveConfig({
    home: HOME,
    cwd: CWD,
    env: opts.env ?? {},
    flags: opts.flags as never,
    readFile: reader(files),
  })
}

describe("resolveHome", () => {
  it("prefers $COGNIA_HOME when set", () => {
    expect(resolveHome({ COGNIA_HOME: "/custom" }, "/home/u")).toBe("/custom")
  })
  it("falls back to ~/.cognia", () => {
    expect(resolveHome({}, "/home/u")).toBe(path.join("/home/u", ".cognia"))
  })
  it("ignores a blank override", () => {
    expect(resolveHome({ COGNIA_HOME: "   " }, "/home/u")).toBe(path.join("/home/u", ".cognia"))
  })
})

describe("resolveConfig defaults", () => {
  it("resolves to defaults with no files/env/flags", () => {
    const cfg = run({})
    expect(cfg.provider).toBe("anthropic")
    expect(cfg.permissionMode).toBe("default")
    expect(cfg.builtinTools.coreFiles).toBe(true)
    expect(cfg.builtinTools.process).toBe(false)
    expect(cfg.providers).toEqual({})
    expect(cfg.cwd).toBe(CWD)
    expect(cfg.model).toBeUndefined()
    expect(cfg.streamIdleTimeoutMs).toBe(60_000)
    expect(cfg.agentBackend).toBe("builtin")
  })

  it("carries the external-agent backend through the flag layer", () => {
    expect(run({}, { flags: { agentBackend: "claude-code" } }).agentBackend).toBe("claude-code")
  })

  it("field-merges notices and clipboard across user + project layers", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        notices: { clipboardUnavailable: "user-clip", copiedReply: "user-reply" },
        clipboard: { osc52: "always", osc52MaxBytes: 1000 },
      }),
      [projectConfigPath(CWD)]: JSON.stringify({
        // Project overrides one notice key + the byte cap; the rest survive.
        notices: { clipboardUnavailable: "project-clip" },
        clipboard: { osc52MaxBytes: 2000 },
      }),
    })
    expect(cfg.notices).toEqual({ clipboardUnavailable: "project-clip", copiedReply: "user-reply" })
    // osc52 mode from the user layer is preserved; the cap is overridden by project.
    expect(cfg.clipboard).toEqual({ osc52: "always", osc52MaxBytes: 2000 })
  })

  it("lets a config file override streamIdleTimeoutMs (0 disables)", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ streamIdleTimeoutMs: 0 }),
    })
    expect(cfg.streamIdleTimeoutMs).toBe(0)
  })

  it("defaults aiSdkMaxSteps to 256 and lets a config file override it", () => {
    expect(run({}).aiSdkMaxSteps).toBe(256)
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ aiSdkMaxSteps: 512 }),
    })
    expect(cfg.aiSdkMaxSteps).toBe(512)
  })

  it("carries devPlugins / devPluginsDir through the merge (flag layer wins)", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ devPlugins: false }) },
      { flags: { devPlugins: true, devPluginsDir: "/repo/plugins" } }
    )
    expect(cfg.devPlugins).toBe(true)
    expect(cfg.devPluginsDir).toBe("/repo/plugins")
  })

  it("defaults toolExecutionTimeoutMs to 120_000 and lets a config file override it (0 disables)", () => {
    expect(run({}).toolExecutionTimeoutMs).toBe(120_000)
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ toolExecutionTimeoutMs: 0 }),
    })
    expect(cfg.toolExecutionTimeoutMs).toBe(0)
  })
})

describe("layer precedence", () => {
  it("applies the user config file", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", model: "gpt-x" }),
    })
    expect(cfg.provider).toBe("openai")
    expect(cfg.model).toBe("gpt-x")
  })

  it("project config overrides user config", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ model: "user-model" }),
      [projectConfigPath(CWD)]: JSON.stringify({ model: "project-model" }),
    })
    expect(cfg.model).toBe("project-model")
  })

  it("env overrides project config", () => {
    const cfg = run(
      { [projectConfigPath(CWD)]: JSON.stringify({ provider: "openai" }) },
      { env: { COGNIA_PROVIDER: "google" } }
    )
    expect(cfg.provider).toBe("google")
  })

  it("flags override env", () => {
    const cfg = run({}, { env: { COGNIA_MODEL: "env-model" }, flags: { model: "flag-model" } })
    expect(cfg.model).toBe("flag-model")
  })
})

describe("explicit model override routing (per-provider)", () => {
  it("routes a --model flag into the active provider's slot", () => {
    const cfg = run({}, { flags: { provider: "deepseek", model: "deepseek-reasoner" } })
    expect(cfg.providers.deepseek?.model).toBe("deepseek-reasoner")
  })

  it("routes COGNIA_MODEL into the active provider's slot", () => {
    const cfg = run({}, { env: { COGNIA_PROVIDER: "openai", COGNIA_MODEL: "gpt-4o" } })
    expect(cfg.providers.openai?.model).toBe("gpt-4o")
  })

  it("promotes a persisted top-level model into the active provider's slot (legacy memory)", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "anthropic", model: "claude-opus-4-8" }),
    })
    // An upgrading user's global pin becomes per-provider memory for the active
    // provider — preserved, and now scoped so it can't bleed onto others.
    expect(cfg.providers.anthropic?.model).toBe("claude-opus-4-8")
  })

  it("does not clobber an existing per-provider model with the legacy top-level pin", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "anthropic",
        model: "legacy-pin",
        providers: { anthropic: { model: "remembered" } },
      }),
    })
    expect(cfg.providers.anthropic?.model).toBe("remembered")
  })
})

describe("credentials overlay", () => {
  it("overlays api keys from credentials.json onto providers", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        providers: { anthropic: { baseURL: "https://x" } },
      }),
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { anthropic: { apiKey: "sk-secret" } },
      }),
    })
    expect(cfg.providers.anthropic).toEqual({ baseURL: "https://x", apiKey: "sk-secret" })
  })

  it("project provider entry merges field-by-field without wiping the key", () => {
    const cfg = run({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { openai: { apiKey: "sk-key" } },
      }),
      [projectConfigPath(CWD)]: JSON.stringify({
        providers: { openai: { baseURL: "https://proxy" } },
      }),
    })
    expect(cfg.providers.openai).toEqual({ apiKey: "sk-key", baseURL: "https://proxy" })
  })

  it("overlays a subscription authToken from credentials.json", () => {
    const cfg = run({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { anthropic: { authToken: "oauth-tok" } },
      }),
    })
    expect(cfg.providers.anthropic).toEqual({ authToken: "oauth-tok" })
  })

  it("resolves search settings with env > credentials > project > user precedence", () => {
    const cfg = run(
      {
        [userConfigPath(HOME)]: JSON.stringify({
          search: {
            defaultProvider: "tavily",
            maxResults: 3,
            providers: { tavily: { apiKey: "user", enabled: true, priority: 9 } },
          },
        }),
        [projectConfigPath(CWD)]: JSON.stringify({
          search: {
            maxResults: 7,
            providers: { tavily: { apiKey: "project", priority: 2 } },
          },
        }),
        [credentialsPath(HOME)]: JSON.stringify({
          searchProviders: { tavily: { apiKey: "credential" } },
        }),
      },
      { env: { COGNIA_SEARCH_TAVILY_API_KEY: "environment" } }
    )

    expect(cfg.search).toMatchObject({ defaultProvider: "tavily", maxResults: 7 })
    expect(cfg.search?.providers?.tavily).toEqual({
      apiKey: "environment",
      enabled: true,
      priority: 2,
    })
  })

  it("maps every search-provider env id and Google CX", () => {
    const cfg = run(
      {},
      {
        env: {
          COGNIA_SEARCH_GOOGLE_API_KEY: "google-key",
          COGNIA_SEARCH_GOOGLE_CX: "cx-id",
          COGNIA_SEARCH_SEARCHAPI_API_KEY: "searchapi-key",
          COGNIA_SEARCH_BRAVE_API_KEY: "brave-key",
        },
      }
    )
    expect(cfg.search?.providers).toMatchObject({
      google: { apiKey: "google-key", cx: "cx-id" },
      searchapi: { apiKey: "searchapi-key" },
      brave: { apiKey: "brave-key" },
    })
  })

  it("ignores an env id the shared search engine cannot execute", () => {
    const cfg = run({}, { env: { COGNIA_SEARCH_GOOGLE_AI_API_KEY: "google-ai-key" } })
    expect(cfg.search?.providers?.["google-ai" as never]).toBeUndefined()
  })
})

describe("subscription token from env", () => {
  it("maps CLAUDE_CODE_OAUTH_TOKEN → providers.anthropic.authToken", () => {
    const cfg = run({}, { env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" } })
    expect(cfg.providers.anthropic.authToken).toBe("oauth-xyz")
  })

  it("keeps both an api key and a subscription token when both are set", () => {
    const cfg = run(
      {},
      { env: { ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" } }
    )
    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant")
    expect(cfg.providers.anthropic.authToken).toBe("oauth-xyz")
  })
})

describe("env provider keys", () => {
  it("maps ANTHROPIC_API_KEY → providers.anthropic.apiKey", () => {
    const cfg = run({}, { env: { ANTHROPIC_API_KEY: "sk-ant" } })
    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant")
  })

  it("maps GEMINI_API_KEY → providers.google.apiKey", () => {
    const cfg = run({}, { env: { GEMINI_API_KEY: "g-key" } })
    expect(cfg.providers.google.apiKey).toBe("g-key")
  })

  it("COGNIA_API_KEY targets the active provider from COGNIA_PROVIDER", () => {
    const cfg = run({}, { env: { COGNIA_PROVIDER: "openai", COGNIA_API_KEY: "sk-active" } })
    expect(cfg.provider).toBe("openai")
    expect(cfg.providers.openai.apiKey).toBe("sk-active")
  })

  it("COGNIA_API_KEY without COGNIA_PROVIDER targets the default provider", () => {
    const cfg = run({}, { env: { COGNIA_API_KEY: "sk-default" } })
    expect(cfg.providers.anthropic.apiKey).toBe("sk-default")
  })

  it("COGNIA_PROTOCOL sets the active provider's wire dialect", () => {
    // The trio that redirects a turn at a custom endpoint: address, key, and
    // the dialect it is spoken in. Overriding only the first two left an
    // Anthropic-format deployment unreachable without editing config.json.
    const cfg = run(
      {},
      {
        env: {
          COGNIA_PROVIDER: "openrouter",
          COGNIA_BASE_URL: "https://gateway.example/provider",
          COGNIA_PROTOCOL: "anthropic",
        },
      }
    )
    expect(cfg.providers.openrouter).toMatchObject({
      baseURL: "https://gateway.example/provider",
      protocol: "anthropic",
    })
  })

  it("rejects an unknown COGNIA_PROTOCOL instead of dropping it", () => {
    // A silently ignored dialect sends the turn in the wrong shape and shows
    // up only as an empty reply — the exact failure this override prevents.
    expect(() => run({}, { env: { COGNIA_PROTOCOL: "antropic" } })).toThrow(
      /unknown protocol "antropic"/
    )
  })

  it("--protocol overrides the config file and binds to the active provider", () => {
    const cfg = run(
      {
        [userConfigPath(HOME)]: JSON.stringify({
          provider: "openrouter",
          providers: { openrouter: { protocol: "openai" } },
        }),
      },
      { flags: { protocol: "anthropic" } }
    )
    expect(cfg.providers.openrouter.protocol).toBe("anthropic")
  })

  it("leaves the provider's stored protocol alone when nothing overrides it", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openrouter",
        providers: { openrouter: { protocol: "openai" } },
      }),
    })
    expect(cfg.providers.openrouter.protocol).toBe("openai")
  })
})

describe("skill discovery config", () => {
  it("reads skillDirs + externalSkills from config.json", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        skillDirs: ["/team/skills"],
        externalSkills: false,
      }),
    })
    expect(cfg.skillDirs).toEqual(["/team/skills"])
    expect(cfg.externalSkills).toBe(false)
  })

  it("defaults to undefined (treated as external-on) when unset", () => {
    const cfg = run({})
    expect(cfg.skillDirs).toBeUndefined()
    expect(cfg.externalSkills).toBeUndefined()
  })

  it("parses COGNIA_SKILL_DIRS as a path-delimited list", () => {
    const cfg = run(
      {},
      { env: { COGNIA_SKILL_DIRS: ["/a/skills", "  ", "/b/skills"].join(path.delimiter) } }
    )
    expect(cfg.skillDirs).toEqual(["/a/skills", "/b/skills"])
  })

  it("treats COGNIA_EXTERNAL_SKILLS=0|false|off as opt-out, else opt-in", () => {
    expect(run({}, { env: { COGNIA_EXTERNAL_SKILLS: "0" } }).externalSkills).toBe(false)
    expect(run({}, { env: { COGNIA_EXTERNAL_SKILLS: "false" } }).externalSkills).toBe(false)
    expect(run({}, { env: { COGNIA_EXTERNAL_SKILLS: "OFF" } }).externalSkills).toBe(false)
    expect(run({}, { env: { COGNIA_EXTERNAL_SKILLS: "1" } }).externalSkills).toBe(true)
  })

  it("lets env override a config-file externalSkills value", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ externalSkills: false }) },
      { env: { COGNIA_EXTERNAL_SKILLS: "true" } }
    )
    expect(cfg.externalSkills).toBe(true)
  })
})

describe("builtinTools merge", () => {
  it("overrides individual toggles, keeping the rest at defaults", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ builtinTools: { process: true, lsp: true } }),
    })
    expect(cfg.builtinTools.process).toBe(true)
    expect(cfg.builtinTools.lsp).toBe(true)
    expect(cfg.builtinTools.coreFiles).toBe(true) // untouched default
    expect(cfg.builtinTools.shellAdvanced).toBe(false) // untouched default
  })
})

describe("cwd resolution", () => {
  it("keeps an absolute cwd as-is", () => {
    const cfg = run({}, { flags: { cwd: "/abs/dir" } })
    expect(cfg.cwd).toBe("/abs/dir")
  })
  it("resolves a relative cwd against the process cwd", () => {
    const cfg = run({}, { flags: { cwd: "sub/dir" } })
    expect(cfg.cwd).toBe(path.resolve(CWD, "sub/dir"))
  })
})

describe("validation errors", () => {
  it("throws on invalid JSON", () => {
    expect(() => run({ [userConfigPath(HOME)]: "{ not json" })).toThrow(
      /config\.json: invalid JSON/
    )
  })
  it("throws on schema violation (unknown key)", () => {
    expect(() => run({ [userConfigPath(HOME)]: JSON.stringify({ bogus: 1 }) })).toThrow(
      /config\.json:/
    )
  })
  it("throws on bad permissionMode enum", () => {
    expect(() =>
      run({ [userConfigPath(HOME)]: JSON.stringify({ permissionMode: "yolo" }) })
    ).toThrow(/config\.json:/)
  })
})

describe("theme config", () => {
  it("reads a persisted theme from config.json", () => {
    const cfg = run({ [userConfigPath(HOME)]: JSON.stringify({ theme: "dark" }) })
    expect(cfg.theme).toBe("dark")
  })

  it("lets env override the config-file theme", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ theme: "dark" }) },
      { env: { COGNIA_THEME: "light" } }
    )
    expect(cfg.theme).toBe("light")
  })

  it("lets flags override env", () => {
    const cfg = run({}, { env: { COGNIA_THEME: "dark" }, flags: { theme: "mono" } })
    expect(cfg.theme).toBe("mono")
  })
})

describe("layout config", () => {
  it("is absent by default (resolver applies the fullscreen default)", () => {
    expect(run({}).layout).toBeUndefined()
  })

  it("reads a persisted layout from config.json", () => {
    const cfg = run({ [userConfigPath(HOME)]: JSON.stringify({ layout: "scrollback" }) })
    expect(cfg.layout).toBe("scrollback")
  })

  it("lets COGNIA_LAYOUT override the config file (case-insensitive)", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ layout: "scrollback" }) },
      { env: { COGNIA_LAYOUT: "FULLSCREEN" } }
    )
    expect(cfg.layout).toBe("fullscreen")
  })

  it("ignores an unrecognized COGNIA_LAYOUT value", () => {
    const cfg = run({}, { env: { COGNIA_LAYOUT: "windowed" } })
    expect(cfg.layout).toBeUndefined()
  })
})

describe("mouse config", () => {
  it("is absent by default (App applies the select default)", () => {
    expect(run({}).mouse).toBeUndefined()
  })

  it("reads a persisted mouse mode from config.json", () => {
    const cfg = run({ [userConfigPath(HOME)]: JSON.stringify({ mouse: "scroll" }) })
    expect(cfg.mouse).toBe("scroll")
  })

  it("lets COGNIA_MOUSE override the config file (case-insensitive)", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ mouse: "scroll" }) },
      { env: { COGNIA_MOUSE: "SELECT" } }
    )
    expect(cfg.mouse).toBe("select")
  })

  it("ignores an unrecognized COGNIA_MOUSE value", () => {
    const cfg = run({}, { env: { COGNIA_MOUSE: "trackpad" } })
    expect(cfg.mouse).toBeUndefined()
  })
})

describe("editor config", () => {
  it("is absent by default (detector decides at use time)", () => {
    expect(run({}).editor).toBeUndefined()
  })

  it("normalizes the string sugar to the object form", () => {
    const cfg = run({ [userConfigPath(HOME)]: JSON.stringify({ editor: "code" }) })
    expect(cfg.editor).toEqual({ command: "code" })
  })

  it("reads the object form verbatim", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ editor: { command: "subl", args: ["-n"] } }),
    })
    expect(cfg.editor).toEqual({ command: "subl", args: ["-n"] })
  })

  it("lets a project layer override the user editor", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ editor: "vim" }),
      [projectConfigPath(CWD)]: JSON.stringify({ editor: "cursor" }),
    })
    expect(cfg.editor).toEqual({ command: "cursor" })
  })

  it("lets COGNIA_EDITOR override the config file", () => {
    const cfg = run(
      { [userConfigPath(HOME)]: JSON.stringify({ editor: { command: "vim", args: ["-p"] } }) },
      { env: { COGNIA_EDITOR: "code" } }
    )
    expect(cfg.editor).toEqual({ command: "code", args: ["-p"] })
  })
})

describe("applyLayer covers the config schema", () => {
  // `applyLayer` is an exhaustive object literal: a key the schema accepts but
  // the literal never names is parsed and then silently discarded. That is
  // worse than rejecting it, because `.strict()` used to make the typo loud.
  // The `sandbox` block shipped that way and made the whole CLI sandbox
  // feature dead on arrival, which no unit test caught because every
  // to-build-context test hand-builds a ResolvedConfig and never runs the
  // loader.
  //
  // This scans the source rather than exercising 60 keys with plausible
  // values, and asserts it actually scanned something so an empty walk cannot
  // pass as "no gaps".
  const KNOWN_UNMERGED = new Set([
    // Pre-existing, all three. Recorded rather than fixed here so this guard
    // does not quietly change three unrelated features at once. The list may
    // only shrink.
    //
    // `autoRoute` is also in BOOLEAN_FLAG_KEYS (mutate.ts), so the settings
    // panel writes a key the loader drops.
    "autoRoute",
    "selection",
    // `protocol` reaches `acc` only through the `--protocol` flag
    // (load.ts:459 reads `flags?.protocol ?? acc.protocol`), so the top-level
    // config-file key is accepted by the schema and discarded.
    "protocol",
  ])

  it("names every schema key, or records the gap", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const url = await import("node:url")
    const { cliConfigFileSchema } = await import("./schema")

    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const source = fs.readFileSync(path.join(here, "load.ts"), "utf8")
    const read = new Set(Array.from(source.matchAll(/\blayer\.([A-Za-z0-9_]+)/g), (m) => m[1]!))
    expect(read.size).toBeGreaterThan(20)

    const schemaKeys = Object.keys(cliConfigFileSchema.shape)
    expect(schemaKeys.length).toBeGreaterThan(20)

    const dropped = schemaKeys.filter((key) => !read.has(key) && !KNOWN_UNMERGED.has(key))
    expect(dropped).toEqual([])
  })

  it("keeps the recorded gaps honest — a fixed one must leave the list", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const url = await import("node:url")
    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const source = fs.readFileSync(path.join(here, "load.ts"), "utf8")
    const read = new Set(Array.from(source.matchAll(/\blayer\.([A-Za-z0-9_]+)/g), (m) => m[1]!))
    const stale = [...KNOWN_UNMERGED].filter((key) => read.has(key))
    expect(stale).toEqual([])
  })
})

describe("sandbox settings survive the loader", () => {
  it("carries enabled / tier / policy from the user config", () => {
    // The behavioural half of the guard above: the source scan proves the key
    // is named, this proves the value arrives.
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({
        sandbox: {
          enabled: true,
          tier: "os",
          policy: { network: "off", maxMemoryMb: 512, writableRoots: ["/work"] },
        },
      }),
    })
    expect(cfg.sandbox).toEqual({
      enabled: true,
      tier: "os",
      policy: { network: "off", maxMemoryMb: 512, writableRoots: ["/work"] },
    })
  })

  it("lets a project config narrow the ceiling without restating the rest", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ sandbox: { enabled: true, tier: "os" } }),
      [projectConfigPath(CWD)]: JSON.stringify({
        sandbox: { policy: { network: "off", writableRoots: [CWD] } },
      }),
    })
    expect(cfg.sandbox).toEqual({
      enabled: true,
      tier: "os",
      policy: { network: "off", writableRoots: [CWD] },
    })
  })

  it("lets a project config turn the sandbox off again", () => {
    const cfg = run({
      [userConfigPath(HOME)]: JSON.stringify({ sandbox: { enabled: true } }),
      [projectConfigPath(CWD)]: JSON.stringify({ sandbox: { enabled: false } }),
    })
    expect(cfg.sandbox?.enabled).toBe(false)
  })

  it("stays absent when nothing configures it", () => {
    expect(run({}).sandbox).toBeUndefined()
  })
})
