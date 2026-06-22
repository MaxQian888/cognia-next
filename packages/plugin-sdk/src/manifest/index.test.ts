import * as manifest from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  A2UIPluginComponentDef,
  A2UITemplateDef,
  PluginManifest,
  PluginDefinition,
  PluginCapability,
  PluginManifestDexieBlock,
  PluginAgentTeamTemplateDef,
  PluginAiProviderDef,
  PluginAuthProviderDef,
  PluginBalanceAdapterDef,
  PluginBinaryRequirement,
  PluginCharacterPackDef,
  PluginChatMiddlewareDef,
  PluginCliToolDef,
  PluginCompactionStrategyDef,
  PluginConfigScope,
  PluginConnectorDef,
  PluginContextProviderDef,
  PluginDensityPresetContribution,
  PluginDeploymentFilterDef,
  PluginExternalAgentAdapterDef,
  PluginExternalAgentPresetDef,
  PluginFontContribution,
  PluginImRateSourceDef,
  PluginLimitsSourceDef,
  PluginLspServerDef,
  PluginManifestCommandDef,
  PluginManifestWorkflowsBlock,
  PluginMcpServerPresetDef,
  PluginMessageRendererDef,
  PluginModalMountDef,
  PluginModeDef,
  PluginNativeAnthropicToolDef,
  PluginOcrProviderDef,
  PluginProtocolAdapterDef,
  PluginQuickActionDef,
  PluginQuickActionSurface,
  PluginResilienceConfig,
  PluginRoutingStrategyDef,
  PluginSharedMemoryAdapterDef,
  PluginSkillDef,
  PluginScheduledTaskDef,
  PluginSubagentDef,
  PluginTerminalCompletionProviderDef,
  PluginToolDef,
  PluginThemePackContribution,
  PluginToolRouteDef,
  PluginViewContainerDef,
  PluginViewDef,
  PluginWallpaperContribution,
  PluginWebviewDef,
  PluginWorkflowTemplateDef,
  PluginWorkspaceBackendDef,
} from "./index"

describe("plugin-sdk: manifest", () => {
  it("exposes definePlugin as a runtime helper", () => {
    expect(typeof manifest.definePlugin).toBe("function")
  })

  it("definePlugin is an identity pass-through that preserves manifest shape", () => {
    const def: PluginDefinition = {
      manifest: {
        id: "com.example.test",
        name: "Test",
        version: "0.0.1",
        description: "test",
        type: "frontend",
        capabilities: ["tools"],
        main: "src/index.ts",
      } as PluginManifest,
      async activate() {
        // no-op
      },
    }
    const result = manifest.definePlugin(def)
    expect(result).toBe(def)
    expect(result.manifest.id).toBe("com.example.test")
  })

  it("re-exports the manifest schema types used at authoring time", () => {
    const capability: PluginCapability = "native-anthropic-tool"
    expect(capability).toBe("native-anthropic-tool")
    const dexie: PluginManifestDexieBlock = {
      tables: [{ name: "items", schema: "++id, name" }],
    }
    expect(dexie.tables[0]?.name).toBe("items")
  })

  it("re-exports manifest contribution entry types for contracted fields", () => {
    const assertContributionTypes = <
      _T extends
        | PluginAiProviderDef
        | PluginAgentTeamTemplateDef
        | PluginAuthProviderDef
        | PluginBalanceAdapterDef
        | PluginBinaryRequirement
        | PluginCharacterPackDef
        | PluginChatMiddlewareDef
        | PluginCliToolDef
        | PluginCompactionStrategyDef
        | PluginConfigScope
        | PluginConnectorDef
        | PluginContextProviderDef
        | PluginDensityPresetContribution
        | PluginDeploymentFilterDef
        | PluginExternalAgentAdapterDef
        | PluginExternalAgentPresetDef
        | PluginFontContribution
        | A2UIPluginComponentDef
        | A2UITemplateDef
        | PluginImRateSourceDef
        | PluginLimitsSourceDef
        | PluginLspServerDef
        | PluginManifestCommandDef
        | PluginManifestWorkflowsBlock
        | PluginMcpServerPresetDef
        | PluginMessageRendererDef
        | PluginModalMountDef
        | PluginModeDef
        | PluginNativeAnthropicToolDef
        | PluginOcrProviderDef
        | PluginProtocolAdapterDef
        | PluginQuickActionDef
        | PluginQuickActionSurface
        | PluginResilienceConfig
        | PluginRoutingStrategyDef
        | PluginSharedMemoryAdapterDef
        | PluginSkillDef
        | PluginScheduledTaskDef
        | PluginSubagentDef
        | PluginTerminalCompletionProviderDef
        | PluginToolDef
        | PluginThemePackContribution
        | PluginToolRouteDef
        | PluginViewContainerDef
        | PluginViewDef
        | PluginWallpaperContribution
        | PluginWebviewDef
        | PluginWorkflowTemplateDef
        | PluginWorkspaceBackendDef,
    >(): void => undefined

    expect(assertContributionTypes).toBeDefined()
  })

  it("declares manifest contribution entry exports in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/manifest/index.ts"),
      "utf8"
    )
    const contributionTypes = [
      "PluginAiProviderDef",
      "PluginAgentTeamTemplateDef",
      "PluginAuthProviderDef",
      "PluginBalanceAdapterDef",
      "PluginBinaryRequirement",
      "PluginCharacterPackDef",
      "PluginChatMiddlewareDef",
      "PluginCliToolDef",
      "PluginCompactionStrategyDef",
      "PluginConfigScope",
      "PluginConnectorDef",
      "PluginContextProviderDef",
      "PluginDensityPresetContribution",
      "PluginDeploymentFilterDef",
      "PluginExternalAgentAdapterDef",
      "PluginExternalAgentPresetDef",
      "PluginFontContribution",
      "A2UIPluginComponentDef",
      "A2UITemplateDef",
      "PluginImRateSourceDef",
      "PluginLimitsSourceDef",
      "PluginLspServerDef",
      "PluginManifestCommandDef",
      "PluginManifestWorkflowsBlock",
      "PluginMcpServerPresetDef",
      "PluginMessageRendererDef",
      "PluginModalMountDef",
      "PluginModeDef",
      "PluginNativeAnthropicToolDef",
      "PluginOcrProviderDef",
      "PluginProtocolAdapterDef",
      "PluginQuickActionDef",
      "PluginQuickActionSurface",
      "PluginResilienceConfig",
      "PluginRoutingStrategyDef",
      "PluginSharedMemoryAdapterDef",
      "PluginSkillDef",
      "PluginScheduledTaskDef",
      "PluginSubagentDef",
      "PluginTerminalCompletionProviderDef",
      "PluginToolDef",
      "PluginThemePackContribution",
      "PluginToolRouteDef",
      "PluginViewContainerDef",
      "PluginViewDef",
      "PluginWallpaperContribution",
      "PluginWebviewDef",
      "PluginWorkflowTemplateDef",
      "PluginWorkspaceBackendDef",
    ]

    for (const contributionType of contributionTypes) {
      expect(barrelSource).toContain(contributionType)
    }
  })

  it("documents the primary manifest contribution entry types in the README table", () => {
    const readme = readFileSync(join(process.cwd(), "packages/plugin-sdk/README.md"), "utf8")
    const documentedTypes = [
      "A2UIPluginComponentDef",
      "A2UITemplateDef",
      "PluginToolDef",
      "PluginCliToolDef",
      "PluginModeDef",
      "PluginManifestCommandDef",
      "PluginQuickActionDef",
      "PluginScheduledTaskDef",
      "PluginLspServerDef",
      "PluginOcrProviderDef",
      "PluginAiProviderDef",
    ]

    for (const documentedType of documentedTypes) {
      expect(readme).toContain(documentedType)
    }
  })
})
