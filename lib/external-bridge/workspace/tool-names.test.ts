import { ALL_BRIDGE_SCOPES } from "@/types/wiki"
import { isWorkspaceToolName, WORKSPACE_TOOL_NAMES, WORKSPACE_TOOL_SCOPES } from "./tool-names"

describe("workspace tool names", () => {
  it("maps every tool to a declared bridge scope", () => {
    expect(WORKSPACE_TOOL_NAMES).toHaveLength(16)
    for (const scope of Object.values(WORKSPACE_TOOL_SCOPES)) {
      expect(ALL_BRIDGE_SCOPES).toContain(scope)
    }
  })

  it("recognizes only its own names", () => {
    expect(isWorkspaceToolName("shell_run")).toBe(true)
    expect(isWorkspaceToolName("toString")).toBe(false)
    expect(isWorkspaceToolName(7)).toBe(false)
  })
})
