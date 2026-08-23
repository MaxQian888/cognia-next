import type { McpServer } from "@cognia/agent-config-types"

import type { ServiceConnection } from "@/types/external-service"
import type { PluginManifest } from "@/types/plugin"
import {
  managedMcpPresetFingerprint,
  purgePluginExternalServices,
  reconcilePluginExternalServiceConnections,
  suspendPluginExternalServices,
} from "./lifecycle"

const manifest = {
  id: "figma-plugin",
  name: "Figma",
  version: "1.0.0",
  type: "frontend",
  capabilities: [],
  services: [
    {
      id: "figma",
      label: "Figma",
      fallbackPolicy: "confirm",
      providers: [
        {
          id: "desktop",
          kind: "mcp",
          contributionId: "figma-local",
          priority: 100,
          surfaces: ["chat", "workflow"],
        },
      ],
    },
  ],
  mcpServerPresets: [
    {
      id: "figma-local",
      name: "Figma Desktop",
      transport: "http",
      config: { url: "http://127.0.0.1:3845/mcp" },
      toolRiskRules: [{ pattern: "get_*", risk: "read" }],
    },
  ],
} satisfies PluginManifest

function server(fingerprint: string): McpServer {
  return {
    id: "server-1",
    name: "figma-plugin-figma-desktop",
    transport: "http",
    config: { url: "http://127.0.0.1:3845/mcp" },
    enabled: false,
    pluginId: "figma-plugin",
    managedBy: {
      pluginId: "figma-plugin",
      serviceId: "figma",
      providerId: "desktop",
      contributionId: "figma-local",
      sourceVersion: "0.9.0",
      specFingerprint: fingerprint,
    },
    createdAt: 1,
    updatedAt: 1,
  } as McpServer
}

function deps(existingServers: McpServer[] = [], existingConnection?: ServiceConnection) {
  const createMcpServer = jest.fn(async (input) => ({
    ...server(input.managedBy?.specFingerprint ?? ""),
    managedBy: input.managedBy,
  }))
  const updateMcpServer = jest.fn(async () => undefined)
  const putServiceConnection = jest.fn(async (row: ServiceConnection) => row)
  return {
    listMcpServersByPlugin: jest.fn(async () => existingServers),
    createMcpServer,
    updateMcpServer,
    getMcpServer: jest.fn(async () => existingServers[0]),
    getServiceConnection: jest.fn(async () => existingConnection),
    putServiceConnection,
    invalidateCapabilityGrants: jest.fn(async () => 0),
    resumePluginServiceConnections: jest.fn(async () => 0),
  }
}

describe("external service managed lifecycle", () => {
  it("does not require browser persistence in Node and CLI hosts", async () => {
    expect(globalThis.indexedDB).toBeUndefined()
    await expect(suspendPluginExternalServices("figma-plugin")).resolves.toBe(0)
    await expect(purgePluginExternalServices("figma-plugin")).resolves.toBeUndefined()
  })

  it("creates a pending server and connection without connecting", async () => {
    const fake = deps()
    expect(await reconcilePluginExternalServiceConnections("figma-plugin", manifest, fake)).toBe(1)
    expect(fake.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, trust: { state: "pending" } })
    )
    expect(fake.putServiceConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        providerRef: { kind: "mcp", serverId: "server-1" },
      })
    )
  })

  it("reopens review and invalidates grants when the provider fingerprint changes", async () => {
    const fake = deps([server("old")])
    await reconcilePluginExternalServiceConnections("figma-plugin", manifest, fake)
    expect(fake.updateMcpServer).toHaveBeenCalledWith(
      "server-1",
      expect.objectContaining({ enabled: false, trust: { state: "pending" } })
    )
    expect(fake.invalidateCapabilityGrants).toHaveBeenCalledWith(
      "plugin:figma-plugin:figma:desktop:account",
      expect.any(String)
    )
  })

  it("fingerprints endpoint and risk policy changes deterministically", async () => {
    const base = await managedMcpPresetFingerprint({
      pluginId: "figma-plugin",
      pluginVersion: "1.0.0",
      serviceId: "figma",
      providerId: "desktop",
      preset: manifest.mcpServerPresets![0],
    })
    const repeat = await managedMcpPresetFingerprint({
      pluginId: "figma-plugin",
      pluginVersion: "1.0.0",
      serviceId: "figma",
      providerId: "desktop",
      preset: manifest.mcpServerPresets![0],
    })
    const changed = await managedMcpPresetFingerprint({
      pluginId: "figma-plugin",
      pluginVersion: "1.0.0",
      serviceId: "figma",
      providerId: "desktop",
      preset: { ...manifest.mcpServerPresets![0], config: { url: "https://example.test/mcp" } },
    })
    expect(base).toBe(repeat)
    expect(base).not.toBe(changed)
  })
})
