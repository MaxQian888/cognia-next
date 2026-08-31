import { resolveRouteBootCapabilities } from "./route-capabilities"

describe("resolveRouteBootCapabilities", () => {
  it.each([
    ["/", "", []],
    ["/plugins", "", ["plugin-runtime"]],
    ["/workflows/editor", "", ["workflow-automation"]],
    ["/integrations", "", ["integrations"]],
    ["/me/mcp", "", ["integrations"]],
    ["/memory", "", ["knowledge-agents"]],
    ["/me/memory-settings", "", ["knowledge-agents"]],
    ["/me/agent-teams-settings", "", ["knowledge-agents"]],
    ["/me/ocr", "", ["knowledge-agents"]],
    ["/agent-teams", "", ["knowledge-agents", "desktop-tools"]],
    ["/me/scheduler", "", ["workflow-automation"]],
    ["/me/workflows-settings", "", ["workflow-automation"]],
    ["/me/a2ui", "", ["workflow-automation"]],
    ["/skills", "", ["knowledge-agents", "desktop-tools"]],
    ["/me/terminal", "", ["desktop-tools"]],
    ["/settings", "?section=plugins", ["plugin-runtime"]],
    ["/settings", "?section=workflows", ["workflow-automation"]],
    ["/settings", "?section=memory", ["knowledge-agents"]],
    ["/settings", "?section=skills", ["knowledge-agents", "desktop-tools"]],
    ["/settings", "?section=desktop", ["desktop-tools"]],
  ])("maps %s%s to its runtime capability", (pathname, search, expected) => {
    expect(resolveRouteBootCapabilities(pathname as string, search as string)).toEqual(expected)
  })
})
