import {
  aboutLine,
  authMode,
  BUILTIN_TOOL_CATALOG,
  buildToolsCatalogDocument,
  describeBuiltinTools,
} from "./builtins"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"

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
  it("summarizes version, provider, model, auth and mode", () => {
    const cfg: ResolvedConfig = {
      ...base,
      providers: { anthropic: { apiKey: "k", model: "claude-x" } },
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
