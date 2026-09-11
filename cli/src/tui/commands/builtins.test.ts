import {
  buildToolCatalogEntries,
  aboutLine,
  authMode,
  BUILTIN_TOOL_CATALOG,
  buildToolsCatalogDocument,
  describeBuiltinTools,
} from "./builtins"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { DEFAULT_BUILTIN_TOOLS, type BuiltinToolsConfig } from "@cognia/agent-config-types"
import {
  BUILTIN_TOOL_CATEGORIES,
  namespaced,
  BUILTIN_TOOL_CONFIG_KEYS,
} from "@/lib/settings/builtin-tools"

const base: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/w",
  model: "claude-x",
  // Per-provider slot mirrors the resolved config — `aboutLine` now reads the
  // active model via `resolveActiveModel`, not the legacy top-level pin.
  providers: { anthropic: { model: "claude-x" } },
}

describe("describeBuiltinTools", () => {
  it("lists enabled categories with friendly labels", () => {
    const tools = { coreFiles: true, git: true, lsp: false } as unknown as BuiltinToolsConfig
    const line = describeBuiltinTools(tools)
    expect(line).toContain("core file tools")
    expect(line).toContain("git")
    expect(line).not.toContain("LSP")
  })

  it("falls back to the raw key for unknown categories", () => {
    const tools = { somethingNew: true } as unknown as BuiltinToolsConfig
    expect(describeBuiltinTools(tools)).toContain("somethingNew")
  })

  it("reports when nothing is enabled", () => {
    const tools = { coreFiles: false } as unknown as BuiltinToolsConfig
    expect(describeBuiltinTools(tools)).toBe("No built-in tools are enabled.")
  })
})

describe("buildToolsCatalogDocument", () => {
  it("renders every catalog category with an enabled/disabled marker and its tools", () => {
    const tools = { coreFiles: true, git: false } as unknown as BuiltinToolsConfig
    const doc = buildToolsCatalogDocument(tools)
    expect(doc).toContain("# Built-in tools")
    // The coreFiles category is enabled and lists its concrete tools.
    expect(doc).toContain("## core file tools  ✓ enabled")
    expect(doc).toContain("multi_edit")
    // git is present but marked disabled.
    expect(doc).toContain("## git  ✗ disabled")
    // External-tool pointers in the footer.
    expect(doc).toContain("/mcp tools")
    expect(doc).toContain("/plugin tools")
  })

  it("covers all catalog categories", () => {
    const doc = buildToolsCatalogDocument({} as BuiltinToolsConfig)
    for (const cat of BUILTIN_TOOL_CATALOG) {
      expect(doc).toContain(`## ${cat.label}`)
    }
  })
})

describe("authMode", () => {
  it("reports subscription when an auth token is present", () => {
    const cfg: ResolvedConfig = { ...base, providers: { anthropic: { authToken: "tok" } } }
    expect(authMode(cfg)).toBe("subscription")
  })

  it("reports api key when only a key is present", () => {
    const cfg: ResolvedConfig = { ...base, providers: { anthropic: { apiKey: "k" } } }
    expect(authMode(cfg)).toBe("api key")
  })

  it("reports no credential when the provider has none", () => {
    expect(authMode(base)).toBe("no credential")
  })
})

describe("aboutLine", () => {
  it("reports the resolved external engine without another provider's model or auth", () => {
    const cfg: ResolvedConfig = {
      ...base,
      agentBackend: "codex",
      providers: { anthropic: { apiKey: "k", model: "claude-x" } },
      agentBackends: { "codex-app-server": { model: "native-model" } },
    }
    const line = aboutLine(cfg, "9.9.9", "codex-app-server")
    expect(line).toContain("codex (codex-app-server)")
    expect(line).toContain("native-model")
    expect(line).not.toMatch(/anthropic|claude-x|api key/)
    expect(aboutLine({ ...cfg, agentBackends: {} }, "9.9.9")).not.toMatch(/claude-x|api key/)
  })
  it("summarizes version, provider, model, auth and mode", () => {
    const cfg: ResolvedConfig = {
      ...base,
      providers: { anthropic: { apiKey: "k", model: "claude-x" } },
      permissionMode: "default",
    }
    const line = aboutLine(cfg, "9.9.9")
    expect(line).toContain("v9.9.9")
    expect(line).toContain("anthropic")
    expect(line).toContain("claude-x")
    expect(line).toContain("api key")
    expect(line).toContain("default mode")
  })

  it("uses 'default' when no model is set", () => {
    // The "default" fallback is only reachable for an UNKNOWN provider (a known
    // provider always resolves to its catalog default). No model + no catalog →
    // resolveActiveModel returns undefined → "default".
    const cfg: ResolvedConfig = {
      ...base,
      provider: "custom-unknown",
      model: undefined,
      providers: {},
    }
    expect(aboutLine(cfg, "1.0.0")).toContain("default")
  })
})

describe("the /tools catalog covers the whole builtin-tool surface", () => {
  it("documents every switchable builtin-tool key", () => {
    const documented = BUILTIN_TOOL_CATALOG.map((entry) => entry.key as string)
    expect(BUILTIN_TOOL_CONFIG_KEYS.filter((key) => !documented.includes(key))).toEqual([])
  })

  it("gives every key a human label in describeBuiltinTools", () => {
    // A key with no label entry falls through to the raw camelCase id, which
    // is how "codeGraph" and "dependencyResearch" used to read in /tools.
    const unlabelled = BUILTIN_TOOL_CATALOG.filter((entry) => {
      const line = describeBuiltinTools({ [entry.key]: true } as unknown as BuiltinToolsConfig)
      return !line.includes(entry.label)
    }).map((entry) => entry.key)
    expect(unlabelled).toEqual([])
  })
})

describe("buildToolCatalogEntries", () => {
  it("lists every canonical tool once, preserving registered names and stable ids", () => {
    const entries = buildToolCatalogEntries({} as BuiltinToolsConfig)
    const names = BUILTIN_TOOL_CATEGORIES.flatMap((category) =>
      category.tools.map((tool) => tool.name)
    )
    expect(entries.map((entry) => entry.name)).toEqual(names)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect(entries.find((entry) => entry.name === "file_hash")?.id).toBe(namespaced("file_hash"))
    expect(entries.some((entry) => entry.name === "hash")).toBe(false)
    expect(entries.some((entry) => entry.name === "file_info")).toBe(true)
    expect(entries.some((entry) => entry.name === "TaskCreate")).toBe(true)
    expect(entries.some((entry) => entry.name === "TodoWrite")).toBe(true)
  })

  it("uses default category flags and honors explicit overrides", () => {
    const defaults = buildToolCatalogEntries({} as BuiltinToolsConfig)
    for (const category of BUILTIN_TOOL_CATEGORIES) {
      for (const tool of category.tools) {
        expect(defaults.find((entry) => entry.name === tool.name)?.enabled).toBe(
          DEFAULT_BUILTIN_TOOLS[category.id]
        )
      }
    }
    const entries = buildToolCatalogEntries({ git: false, process: true } as BuiltinToolsConfig)
    expect(entries.find((entry) => entry.name === "git_status")?.enabled).toBe(false)
    expect(entries.find((entry) => entry.name === "start_process")?.enabled).toBe(true)
  })

  it("localizes tool descriptions and metadata without translating tool identifiers", () => {
    const en = buildToolCatalogEntries(DEFAULT_BUILTIN_TOOLS, "en")
    const zh = buildToolCatalogEntries(DEFAULT_BUILTIN_TOOLS, "zh-CN")
    expect(zh.map((entry) => entry.id)).toEqual(en.map((entry) => entry.id))
    const hash = zh.find((entry) => entry.name === "file_hash")!
    expect(hash.description).toMatch(/[\u4e00-\u9fff]/)
    expect(hash.detail).toContain("类别：")
    expect(hash.detail).toContain("声明风险：低")
    expect(hash.detail).toContain("工具策略不要求审批")
    for (const entry of [...en, ...zh]) {
      expect(entry.description).toBeTruthy()
      expect(entry.description).not.toMatch(/^tools\./)
      expect(entry.detail).not.toContain("cliUiCommon.")
      expect(entry.source).toBe("builtin")
    }
  })

  it("shows permission metadata and the static schema/runtime boundary", () => {
    const entries = buildToolCatalogEntries(DEFAULT_BUILTIN_TOOLS)
    const process = entries.find((entry) => entry.name === "start_process")!
    expect(process.detail).toContain("Declared risk: High")
    expect(process.detail).toContain("required by the tool policy")
    expect(process.detail).toContain("not included in this static catalog")
    expect(process.detail).toContain("do not guarantee that each tool is exposed")
    expect(process.detail).not.toContain(process.description)
  })

  it("treats Anthropic core registration as a modifier, never a duplicate tool or standalone enablement", () => {
    const off = buildToolCatalogEntries({
      coreFiles: false,
      coreFilesOnAnthropic: true,
    } as BuiltinToolsConfig)
    const read = off.find((entry) => entry.name === "read")!
    expect(read.enabled).toBe(false)
    expect(read.detail).toContain("Core-file registration on Anthropic: enabled")
    expect(off.filter((entry) => entry.name === "read")).toHaveLength(1)
    expect(off.find((entry) => entry.name === "git_status")?.detail).not.toContain(
      "Core-file registration"
    )
    expect(
      buildToolCatalogEntries({ coreFilesOnAnthropic: false } as BuiltinToolsConfig).find(
        (entry) => entry.name === "read"
      )?.detail
    ).toContain("Core-file registration on Anthropic: disabled")
  })
})
