import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

import {
  __resetExternalServiceCatalogForTesting,
  listExternalCapabilities,
  registerExternalServices,
} from "../catalog"
import { projectManagedMcpCapabilities } from "./mcp"
import { __resetManagedMcpChatSurfacesForTesting } from "./mcp-chat"

beforeEach(() => {
  __resetExternalServiceCatalogForTesting()
  __resetManagedMcpChatSurfacesForTesting()
})

describe("managed MCP capability projection", () => {
  it("projects tools, resources, and prompts with fail-closed unknown tool risk", () => {
    registerExternalServices("figma-plugin", [
      {
        id: "figma",
        label: "Figma",
        fallbackPolicy: "confirm",
        providers: [
          {
            id: "mcp",
            kind: "mcp",
            contributionId: "figma",
            priority: 100,
            surfaces: ["chat", "workflow"],
          },
        ],
      },
    ])
    const server = {
      id: "server-1",
      name: "figma",
      transport: "http",
      config: { url: "https://mcp.example.test" },
      enabled: true,
      managedBy: {
        pluginId: "figma-plugin",
        serviceId: "figma",
        providerId: "mcp",
        contributionId: "figma",
        sourceVersion: "1.0.0",
        specFingerprint: "fingerprint",
      },
      toolRiskRules: [
        { pattern: "get_*", risk: "read" },
        {
          pattern: "update_*",
          risk: "write",
          selectors: [{ kind: "file", jsonPointer: "/fileKey" }],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    } as McpServer
    const discovery = {
      id: "cache",
      serverId: server.id,
      fingerprint: "fingerprint",
      tools: [{ name: "get_context" }, { name: "update_design" }, { name: "new_tool" }],
      resources: [{ uri: "figma://file/1", name: "File" }],
      prompts: [{ name: "design_rules", arguments: [{ name: "framework" }] }],
      expiresAt: 100,
      updatedAt: 1,
    } satisfies McpCapabilityCacheRow

    expect(projectManagedMcpCapabilities(server, discovery)).toBe(true)
    expect(listExternalCapabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "get_context", risk: "read", policyKnown: true }),
        expect.objectContaining({
          capabilityId: "update_design",
          risk: "write",
          scopeSelectors: [{ kind: "file", jsonPointer: "/fileKey" }],
        }),
        expect.objectContaining({ capabilityId: "new_tool", risk: "write", policyKnown: false }),
        expect.objectContaining({ capabilityId: "figma://file/1", kind: "resource", risk: "read" }),
        expect.objectContaining({ capabilityId: "design_rules", kind: "prompt", risk: "read" }),
      ])
    )
  })
})
