import {
  CANONICAL_PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_CONTRACTS,
  CANONICAL_EXTENSION_POINTS,
  CANONICAL_RUNTIME_POINTS,
  auditPluginCapabilityContracts,
  getExtensionPointContract,
  getAllContributions,
  getContributionsForCapability,
  getPluginCapabilityContract,
  getRuntimePointContract,
  validatePluginCapabilities,
} from "./index"

describe("plugin-sdk: contracts", () => {
  it("re-exports capability contract metadata for all canonical capabilities", () => {
    expect(CANONICAL_PLUGIN_CAPABILITIES).toContain("auth-provider")
    expect(CANONICAL_PLUGIN_CAPABILITIES).toContain("quick-action")
    expect(PLUGIN_CAPABILITY_CONTRACTS.length).toBe(CANONICAL_PLUGIN_CAPABILITIES.length)
  })

  it("exposes capability lookup, validation, and proof-audit helpers", () => {
    expect(getPluginCapabilityContract("auth-provider")?.manifestFields).toEqual(["authProviders"])
    expect(validatePluginCapabilities(["auth-provider"]).allowed).toBe(true)
    expect(validatePluginCapabilities(["missing-capability"]).allowed).toBe(false)
    expect(auditPluginCapabilityContracts().some((entry) => entry.id === "auth-provider")).toBe(
      true
    )
  })

  it("records SDK runtime facades for context-backed capability tags", () => {
    expect(getPluginCapabilityContract("media")?.typescriptSdk).toEqual(
      expect.arrayContaining(["packages/plugin-sdk/src/api/media.ts"])
    )
    expect(getPluginCapabilityContract("canvas")?.typescriptSdk).toEqual(
      expect.arrayContaining(["packages/plugin-sdk/src/api/canvas.ts"])
    )
    expect(getPluginCapabilityContract("python")?.typescriptSdk).toEqual(
      expect.arrayContaining(["packages/plugin-sdk/src/api/python.ts"])
    )
    expect(getPluginCapabilityContract("automation")?.typescriptSdk).toEqual([
      "packages/plugin-sdk/src/api/automation.ts",
    ])
    expect(getPluginCapabilityContract("companion")?.typescriptSdk).toEqual([
      "packages/plugin-sdk/src/api/companion.ts",
    ])
    expect(getPluginCapabilityContract("providers")?.typescriptSdk).toEqual(
      expect.arrayContaining(["packages/plugin-sdk/src/api/ai-provider.ts"])
    )
    expect(getPluginCapabilityContract("processors")?.typescriptSdk).toEqual([])
  })

  it("re-exports extension-point contracts through the same audit subpath", () => {
    const point = CANONICAL_EXTENSION_POINTS[0]
    expect(point).toBeDefined()
    expect(getExtensionPointContract(point)?.id).toBe(point)
  })

  it("exposes implemented runtime registry point contracts through the SDK subpath", () => {
    const implementedRuntimePoints = [
      "terminal.completion",
      "provider.routing-strategy",
      "provider.deployment-filter",
      "provider.protocol-adapter",
      "agent.external-agent-adapter",
      "agent.tool-route",
      "agent.context-provider",
      "connectors.adapter",
      "subscription.balance-adapter",
      "subscription.limits-source",
      "connectors.im-rate-source",
      "chat.compaction-strategy",
      "quick-action",
      "appearance.font",
      "appearance.wallpaper",
      "appearance.density-preset",
      "view.container",
      "view.tree",
      "view.webview",
      "agent.skill",
      "agent.mcp-server-preset",
      "agent.native-anthropic-tool",
      "agent.external-agent-preset",
      "character.pack",
      "agent.subagent",
      "agent.team-template",
      "agent.shared-memory-adapter",
      "workflow.template",
      "auth.provider",
      "agent.tool",
      "a2ui.component",
      "a2ui.template",
      "agent.mode",
      "command.slash",
      "importer.format",
      "exporter.format",
      "appearance.theme",
      "appearance.theme-pack",
      "lsp.server",
      "cli.tool",
      "tray.item",
      "uri.handler",
    ] as const

    for (const point of implementedRuntimePoints) {
      expect(CANONICAL_RUNTIME_POINTS).toContain(point)
      const contract = getRuntimePointContract(point as (typeof CANONICAL_RUNTIME_POINTS)[number])
      expect(contract).toEqual(
        expect.objectContaining({
          id: point,
          kind: "runtime",
          status: "implemented",
        })
      )
      expect(contract.binding).toEqual(expect.any(String))
      expect(contract.binding).not.toBe("")
    }
  })

  it("exposes contribution-summary helpers for field-driven module bridge surfaces", () => {
    const manifest = {
      chatMiddlewares: [{ id: "redact", name: "Redactor" }],
      views: [{ id: "outline", title: "Outline" }],
    }

    expect(getContributionsForCapability(manifest, "chat-middleware")).toEqual([
      { id: "redact", label: "Redactor" },
    ])
    expect(getAllContributions(["tree-view", "tool-route"], manifest)).toEqual([
      { capability: "tree-view", entries: [{ id: "outline", label: "Outline" }], count: 1 },
      { capability: "tool-route", entries: [], count: 0 },
    ])
  })
})
