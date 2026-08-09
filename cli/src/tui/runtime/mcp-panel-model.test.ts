import {
  enterAction,
  filterMcpServers,
  filterMcpTools,
  fixHint,
  connectionIssueDetails,
  connectionIssueTitle,
  patchServerStatus,
  statusBadge,
  type McpPanelServer,
  type McpPanelTool,
} from "./mcp-panel-model"

const srv = (over: Partial<McpPanelServer> = {}): McpPanelServer => ({
  name: "github",
  transport: "http",
  enabled: true,
  status: "connected",
  ...over,
})

describe("connectionIssueDetails", () => {
  it("keeps the transport and multi-line stderr/timeout reason for diagnosis", () => {
    expect(
      connectionIssueDetails(
        srv({
          name: "context7",
          transport: "stdio",
          status: "failed",
          error: "MCP probe timed out after 12000ms\nError: CONTEXT7_API_KEY is missing",
        })
      )
    ).toEqual([
      "Timeout while connecting over stdio.",
      "MCP probe timed out after 12000ms",
      "Error: CONTEXT7_API_KEY is missing",
    ])
  })

  it("explains authorization failures without inventing an error", () => {
    expect(connectionIssueDetails(srv({ status: "needs_auth" }))).toEqual([
      "Authentication required for http. Press Enter to authorize.",
    ])
  })

  it.each([
    [srv({ enabled: false, status: "disabled" }), []],
    [srv({ status: "connected" }), []],
    [srv({ status: "pending" }), []],
  ])("omits connection diagnostics for disabled or healthy states", (server, expected) => {
    expect(connectionIssueDetails(server)).toEqual(expected)
  })

  it("reports a generic non-timeout failure when the transport has no detail", () => {
    expect(connectionIssueDetails(srv({ status: "failed", error: undefined }))).toEqual([
      "Connection over http failed.",
      "No error detail was reported by the transport.",
    ])
  })

  it("keeps only the last three stderr lines", () => {
    expect(
      connectionIssueDetails(srv({ status: "failed", error: "one\ntwo\nthree\nfour" }))
    ).toEqual(["Connection over http failed.", "two", "three", "four"])
  })

  it("builds the selected-server heading", () => {
    expect(connectionIssueTitle(srv({ name: "context7" }))).toBe("Connection issue · context7")
  })
})

describe("statusBadge", () => {
  it("maps each status to a coloured bullet", () => {
    expect(statusBadge(srv({ status: "connected" })).token).toBe("success")
    expect(statusBadge(srv({ status: "needs_auth" })).token).toBe("warning")
    expect(statusBadge(srv({ status: "failed" })).token).toBe("danger")
    expect(statusBadge(srv({ status: "pending" })).token).toBe("info")
  })

  it("shows disabled regardless of the last probe", () => {
    const badge = statusBadge(srv({ enabled: false, status: "connected" }))
    expect(badge.token).toBe("muted")
    expect(badge.label).toBe("disabled")
    expect(badge.glyph).toBe("○")
  })
})

describe("fixHint", () => {
  it("tells the user the exact key to fix each state", () => {
    expect(fixHint(srv({ status: "needs_auth" }))).toBe("enter authorizes")
    expect(fixHint(srv({ enabled: false }))).toBe("space enables")
    expect(fixHint(srv({ status: "failed", error: "ECONNREFUSED" }))).toContain("enter reconnects")
    expect(fixHint(srv({ status: "failed", error: "ECONNREFUSED" }))).toContain("ECONNREFUSED")
  })

  it("returns no hint while pending", () => {
    expect(fixHint(srv({ status: "pending" }))).toBeNull()
  })

  it("shows the tool count for a connected server", () => {
    expect(fixHint(srv({ status: "connected", toolCount: 12 }))).toBe("12 tools · enter")
    expect(fixHint(srv({ status: "connected" }))).toBe("enter for tools")
  })

  it("collapses multi-line errors and truncates long ones", () => {
    const hint = fixHint(srv({ status: "failed", error: "line one\nline two ".repeat(20) }))
    expect(hint).not.toContain("\n")
    expect(hint!.length).toBeLessThan(60)
  })
})

describe("enterAction", () => {
  it("maps each status to its context-sensitive Enter action", () => {
    expect(enterAction(srv({ status: "connected" }))).toBe("tools")
    expect(enterAction(srv({ status: "needs_auth" }))).toBe("auth")
    expect(enterAction(srv({ status: "failed" }))).toBe("reconnect")
    expect(enterAction(srv({ status: "pending" }))).toBe("none")
    expect(enterAction(srv({ enabled: false }))).toBe("enable")
  })
})

describe("filterMcpServers", () => {
  const servers = [
    srv({ name: "github" }),
    srv({ name: "filesystem" }),
    srv({ name: "git-extras" }),
  ]
  it("keeps original order for an empty query", () => {
    expect(filterMcpServers(servers, "").map((s) => s.name)).toEqual([
      "github",
      "filesystem",
      "git-extras",
    ])
  })
  it("fuzzy-filters by name", () => {
    expect(filterMcpServers(servers, "git").map((s) => s.name)).toEqual(["github", "git-extras"])
  })
})

describe("filterMcpTools", () => {
  const tools: McpPanelTool[] = [
    { name: "create_issue", description: "open a github issue", enabled: true },
    { name: "list_repos", description: "list repositories", enabled: true },
  ]
  it("matches name or description", () => {
    expect(filterMcpTools(tools, "issue").map((t) => t.name)).toEqual(["create_issue"])
    expect(filterMcpTools(tools, "repositories").map((t) => t.name)).toEqual(["list_repos"])
  })
})

describe("patchServerStatus", () => {
  it("updates only the named server, immutably", () => {
    const servers = [srv({ name: "a", status: "pending" }), srv({ name: "b", status: "pending" })]
    const out = patchServerStatus(servers, "a", { status: "connected", toolCount: 3 })
    expect(out[0]).toMatchObject({ name: "a", status: "connected", toolCount: 3 })
    expect(out[1].status).toBe("pending")
    expect(out).not.toBe(servers)
    expect(servers[0].status).toBe("pending") // original untouched
  })
})
