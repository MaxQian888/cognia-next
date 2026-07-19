import { detectMemoryExternalContext } from "./contamination"

describe("detectMemoryExternalContext", () => {
  it("marks web, document, MCP, screen, tool-search, and connector results", () => {
    expect(
      detectMemoryExternalContext([
        {
          parts: [
            { type: "source-url" },
            { type: "source-document" },
            { type: "tool-mcp__docs__lookup" },
            { type: "dynamic-tool", toolName: "tool_search" },
            { type: "tool-screenshot" },
            { type: "tool-slack_search" },
            { type: "tool-WebSearch" },
            { type: "tool-WebFetch" },
          ],
        },
      ]).sort()
    ).toEqual(["connector", "document", "mcp", "screen", "tool-search", "web-search"])
  })

  it("keeps local code tools eligible even when routed through the local MCP server", () => {
    expect(
      detectMemoryExternalContext([
        { parts: [{ type: "tool-Bash" }, { type: "tool-mcp__cognia-tools__Read" }] },
      ])
    ).toEqual(["local-tool"])
  })

  it("does not trust local-looking leaves from arbitrary MCP servers or unknown tools", () => {
    expect(
      detectMemoryExternalContext([
        {
          parts: [
            { type: "tool-mcp__remote-files__read_document" },
            { type: "dynamic-tool", toolName: "custom_lookup" },
          ],
        },
      ])
    ).toEqual(["mcp"])
  })
})
