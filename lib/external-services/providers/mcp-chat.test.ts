import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

jest.mock("@/lib/mcp/runtime-gateway", () => ({
  defaultMcpRuntimeGateway: { readResource: jest.fn(), getPrompt: jest.fn() },
}))

jest.mock("@/lib/mcp/credentials", () => ({
  resolveMcpSecrets: jest.fn(async (config: unknown) => config),
}))

import {
  __clearDocsProvidersForTests,
  getDocsProvider,
  type RemoteDocRef,
} from "@/lib/docs-providers"
import {
  __resetSlashCommandsForTesting,
  dispatchSlashCommand,
  listSlashCommands,
} from "@/lib/slash-commands/registry"
import { defaultMcpRuntimeGateway } from "@/lib/mcp/runtime-gateway"
import {
  __resetManagedMcpChatSurfacesForTesting,
  syncManagedMcpChatSurfaces,
  unregisterManagedMcpChatSurfacesByPlugin,
} from "./mcp-chat"

const readResource = defaultMcpRuntimeGateway.readResource as jest.Mock
const getPrompt = defaultMcpRuntimeGateway.getPrompt as jest.Mock

const server = {
  id: "server-1",
  name: "Figma Local",
  displayName: "Figma Desktop",
  transport: "http",
  config: { url: "http://127.0.0.1:3845/mcp" },
  enabled: true,
  managedBy: {
    pluginId: "figma-plugin",
    serviceId: "figma",
    providerId: "desktop",
    contributionId: "figma-local",
    sourceVersion: "1.0.0",
    specFingerprint: "fp",
  },
  createdAt: 1,
  updatedAt: 1,
} as McpServer

const discovery = {
  resources: [
    {
      uri: "figma://file/abc",
      name: "Checkout design",
      description: "Selected frame",
      mimeType: "text/markdown",
    },
  ],
  prompts: [
    {
      name: "implement",
      description: "Prepare implementation context",
      arguments: [{ name: "framework", required: true }],
    },
  ],
} satisfies Pick<McpCapabilityCacheRow, "resources" | "prompts">

describe("managed MCP chat surfaces", () => {
  beforeEach(() => {
    __resetManagedMcpChatSurfacesForTesting()
    __clearDocsProvidersForTests()
    __resetSlashCommandsForTesting()
    jest.clearAllMocks()
  })

  it("projects resources into the remote-document attachment path", async () => {
    readResource.mockResolvedValue({
      contents: [{ uri: "figma://file/abc", text: "# Checkout", mimeType: "text/markdown" }],
    })
    syncManagedMcpChatSurfaces(server, discovery)

    const provider = getDocsProvider("mcp:server-1")
    expect(await provider?.listAccounts()).toEqual([{ id: "server-1", label: "Figma Desktop" }])
    expect(await provider?.search?.("checkout", { accountId: "server-1", limit: 10 })).toEqual([
      expect.objectContaining({ id: "figma://file/abc", kind: "resource" }),
    ])
    const ref = {
      providerId: "mcp:server-1",
      kind: "resource",
      id: "figma://file/abc",
      title: "Checkout design",
    } satisfies RemoteDocRef
    await expect(provider?.fetch(ref, { accountId: "server-1" })).resolves.toMatchObject({
      text: "# Checkout",
      format: "markdown",
    })
    expect(readResource).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "figma://file/abc", surface: "chat", interactive: true })
    )
  })

  it("projects prompts as namespaced commands and preserves provenance", async () => {
    getPrompt.mockResolvedValue({
      messages: [{ role: "user", content: { type: "text", text: "Use React" } }],
    })
    syncManagedMcpChatSurfaces(server, discovery)

    expect(listSlashCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mcp__figma_local__implement", pluginId: "figma-plugin" }),
      ])
    )
    const result = await dispatchSlashCommand(
      '/external-mcp:server-1:implement {"framework":"React"}',
      { sessionId: "session-1" }
    )
    expect(result?.message).toContain('<mcp_prompt server="Figma Local" prompt="implement">')
    expect(result?.message).toContain("Use React")
    expect(getPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: "session-1",
        promptName: "implement",
        arguments: { framework: "React" },
      })
    )
  })

  it("fails closed on missing prompt arguments and cleans up by plugin", async () => {
    syncManagedMcpChatSurfaces(server, discovery)
    await expect(dispatchSlashCommand("/external-mcp:server-1:implement")).rejects.toThrow(
      /Missing required/
    )
    expect(unregisterManagedMcpChatSurfacesByPlugin("figma-plugin")).toBe(1)
    expect(getDocsProvider("mcp:server-1")).toBeUndefined()
    expect(listSlashCommands()).toEqual([])
  })
})
