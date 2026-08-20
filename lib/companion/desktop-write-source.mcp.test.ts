/**
 * @jest-environment jsdom
 *
 * The two MCP desktop-write arms. Kept out of `desktop-write-source.test.ts`
 * (real Dexie) because what matters here is the dispatch contract — that the
 * arm validates its payload and hands `updateMcpServer` exactly what the
 * paired client asked for, so the trust gate, the summary mirror and the agent
 * file sync all run the same way a desktop toggle makes them run.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/db/mcp-servers", () => ({
  updateMcpServer: jest.fn(async () => undefined),
}))

import { dispatchCommand } from "./desktop-write-source"

const mcpServers = jest.requireMock("@/lib/db/mcp-servers") as Record<string, jest.Mock>

beforeEach(() => jest.clearAllMocks())

describe("dispatchCommand: mcp_set_enabled", () => {
  it("routes the toggle through updateMcpServer, not a bare Dexie write", async () => {
    await expect(
      dispatchCommand("mcp_set_enabled", { id: "mcp_1", enabled: false })
    ).resolves.toBeNull()
    expect(mcpServers.updateMcpServer).toHaveBeenCalledWith("mcp_1", { enabled: false })
  })

  it("requires an id and a real boolean", async () => {
    await expect(dispatchCommand("mcp_set_enabled", { enabled: true })).rejects.toThrow(
      /mcp_set_enabled.id is required/
    )
    await expect(
      dispatchCommand("mcp_set_enabled", { id: "mcp_1", enabled: "yes" })
    ).rejects.toThrow(/mcp_set_enabled.enabled must be boolean/)
    expect(mcpServers.updateMcpServer).not.toHaveBeenCalled()
  })
})

describe("dispatchCommand: mcp_set_tool_rules", () => {
  it("replaces the exact deny list", async () => {
    await expect(
      dispatchCommand("mcp_set_tool_rules", { id: "mcp_1", disallowedTools: ["write_file"] })
    ).resolves.toBeNull()
    expect(mcpServers.updateMcpServer).toHaveBeenCalledWith("mcp_1", {
      disallowedTools: ["write_file"],
    })
  })

  it("replaces the pattern list", async () => {
    await dispatchCommand("mcp_set_tool_rules", {
      id: "mcp_1",
      disallowedToolPatterns: ["write_*"],
    })
    expect(mcpServers.updateMcpServer).toHaveBeenCalledWith("mcp_1", {
      disallowedToolPatterns: ["write_*"],
    })
  })

  it("carries an empty list through, so a client can clear every rule", async () => {
    await dispatchCommand("mcp_set_tool_rules", { id: "mcp_1", disallowedTools: [] })
    expect(mcpServers.updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedTools: [] })
  })

  it("leaves an axis the client did not send untouched", async () => {
    await dispatchCommand("mcp_set_tool_rules", { id: "mcp_1", disallowedTools: ["a"] })
    expect(mcpServers.updateMcpServer.mock.calls[0][1]).not.toHaveProperty("disallowedToolPatterns")
  })

  it("requires an id", async () => {
    await expect(dispatchCommand("mcp_set_tool_rules", { disallowedTools: [] })).rejects.toThrow(
      /mcp_set_tool_rules.id is required/
    )
  })

  it("refuses a call that would change nothing", async () => {
    await expect(dispatchCommand("mcp_set_tool_rules", { id: "mcp_1" })).rejects.toThrow(
      /requires disallowedTools or disallowedToolPatterns/
    )
    expect(mcpServers.updateMcpServer).not.toHaveBeenCalled()
  })

  it("rejects a non-string-array payload rather than writing junk", async () => {
    await expect(
      dispatchCommand("mcp_set_tool_rules", { id: "mcp_1", disallowedTools: "write_file" })
    ).rejects.toThrow(/disallowedTools must be a string array/)
    await expect(
      dispatchCommand("mcp_set_tool_rules", { id: "mcp_1", disallowedToolPatterns: [1, 2] })
    ).rejects.toThrow(/disallowedToolPatterns must be a string array/)
    expect(mcpServers.updateMcpServer).not.toHaveBeenCalled()
  })
})
