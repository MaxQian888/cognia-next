/** @jest-environment node */
import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

import {
  loadMcpAppForTool,
  parseNamespacedMcpToolName,
  promoteMcpAppDownload,
} from "./apps-runtime"

const server = {
  id: "figma-id",
  name: "figma-local",
  transport: "http",
  config: { url: "http://127.0.0.1:3845/mcp", allowPrivateNetwork: true },
  enabled: true,
  toolRiskRules: [{ pattern: "delete_*", risk: "destructive" }],
} as McpServer

function cache(meta: Record<string, unknown>): McpCapabilityCacheRow {
  return {
    id: "cache",
    serverId: server.id,
    fingerprint: "fingerprint",
    tools: [{ name: "delete_frame", _meta: meta }],
    resources: [],
    prompts: [],
    expiresAt: 2,
    updatedAt: 1,
  }
}

describe("MCP Apps runtime wiring", () => {
  it("parses exact Anthropic MCP namespaces", () => {
    expect(parseNamespacedMcpToolName("mcp__figma-local__delete_frame")).toEqual({
      namespace: "figma-local",
      toolName: "delete_frame",
    })
    expect(parseNamespacedMcpToolName("delete_frame")).toBeUndefined()
  })

  it("loads the declared UI resource and risk overlay", async () => {
    const readResource = jest.fn(async () => ({
      html: "<main>Figma</main>",
      csp: { connectDomains: ["https://api.figma.com"] },
      permissions: { clipboardWrite: {} },
    }))
    await expect(
      loadMcpAppForTool("mcp__figma-local__delete_frame", "chat-1", {
        listServers: async () => [server],
        loadCapabilities: async () => [cache({ ui: { resourceUri: "ui://figma/editor" } })],
        readResource,
      })
    ).resolves.toEqual({
      server,
      toolName: "delete_frame",
      resourceUri: "ui://figma/editor",
      html: "<main>Figma</main>",
      csp: { connectDomains: ["https://api.figma.com"] },
      permissions: { clipboardWrite: {} },
      risk: "destructive",
    })
    expect(readResource).toHaveBeenCalledWith(server, "ui://figma/editor", "chat-1")
  })

  it("supports the deprecated flat resource URI and defaults unknown tools to write", async () => {
    const plain = { ...server, toolRiskRules: [] } as McpServer
    const loaded = await loadMcpAppForTool("mcp__figma-local__delete_frame", "chat-1", {
      listServers: async () => [plain],
      loadCapabilities: async () => [cache({ "ui/resourceUri": "ui://figma/legacy" })],
      readResource: async () => ({ html: "legacy" }),
    })
    expect(loaded?.resourceUri).toBe("ui://figma/legacy")
    expect(loaded?.risk).toBe("write")
  })

  it("fails closed for undeclared, invalid, or missing app metadata", async () => {
    const base = { listServers: async () => [server], readResource: jest.fn() }
    await expect(
      loadMcpAppForTool("mcp__figma-local__delete_frame", "chat", {
        ...base,
        loadCapabilities: async () => [cache({ ui: { resourceUri: "https://evil.test" } })],
      })
    ).resolves.toBeUndefined()
    await expect(
      loadMcpAppForTool("mcp__other__delete_frame", "chat", {
        ...base,
        loadCapabilities: async () => [cache({})],
      })
    ).resolves.toBeUndefined()
    expect(base.readResource).not.toHaveBeenCalled()
  })

  it("promotes only embedded quarantine contents through explicit save dependencies", async () => {
    const saveText = jest.fn(async () => true)
    const saveBinary = jest.fn(async () => true)
    await expect(
      promoteMcpAppDownload(
        server,
        "chat",
        [
          {
            type: "resource",
            resource: { uri: "ui://figma/report.txt", text: "report", mimeType: "text/plain" },
          },
          {
            type: "resource",
            resource: {
              uri: "ui://figma/image.png",
              blob: "AQID",
              mimeType: "image/png",
            },
          },
          { type: "text", text: "not downloadable" },
        ],
        { saveText, saveBinary }
      )
    ).resolves.toBe(2)
    expect(saveText).toHaveBeenCalledWith({ defaultName: "report.txt", content: "report" })
    expect(saveBinary.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        defaultName: "image.png",
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      })
    )
  })

  it("fetches linked quarantine resources through the same MCP lease before saving", async () => {
    const saveText = jest.fn(async () => true)
    const readLinked = jest.fn(async () => ({
      uri: "report://daily.csv",
      text: "a,b\n1,2",
      mimeType: "text/csv",
    }))
    await expect(
      promoteMcpAppDownload(
        server,
        "chat",
        [{ type: "resource_link", uri: "report://daily.csv" }],
        { saveText, readLinked }
      )
    ).resolves.toBe(1)
    expect(readLinked).toHaveBeenCalledWith(server, "report://daily.csv", "chat")
    expect(saveText).toHaveBeenCalledWith({ defaultName: "daily.csv", content: "a,b\n1,2" })
  })
})
