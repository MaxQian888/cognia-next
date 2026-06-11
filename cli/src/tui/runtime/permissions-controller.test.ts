import {
  buildPermissionsReport,
  permissionsClear,
  permissionsList,
  permissionsRemove,
} from "./permissions-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

describe("buildPermissionsReport", () => {
  it("reports mode + auto count and 'none' when nothing is always-allowed", () => {
    const r = buildPermissionsReport("default", 30, [])
    expect(r).toContain("Permission mode: default")
    expect(r).toContain("Auto-approved (read-only) tools: 30")
    expect(r).toContain("Always-allowed: none")
  })

  it("lists always-allowed tools de-namespaced and sorted, with scope/TTL", () => {
    const now = 1_000_000
    const r = buildPermissionsReport(
      "acceptEdits",
      30,
      [
        { tool: "mcp__cognia-tools__write" },
        { tool: "mcp__cognia-tools__bash", cwd: "/proj", expiresAt: now - 1 },
      ],
      now
    )
    expect(r).toContain("Always-allowed (2):")
    expect(r.indexOf("• bash")).toBeLessThan(r.indexOf("• write"))
    expect(r).toContain("in /proj")
    expect(r).toContain("expired")
    expect(r).toContain("/permissions remove")
  })
})

describe("permissionsList", () => {
  it("dispatches a notice from the resolved approval entries", () => {
    const actions: TuiAction[] = []
    permissionsList({
      dispatch: (a) => actions.push(a),
      config,
      home: "/home",
      readEntries: () => [{ tool: "mcp__cognia-tools__bash" }],
    })
    expect(actions).toHaveLength(1)
    if (actions[0].type === "NOTICE") expect(actions[0].message).toContain("• bash")
  })
})

describe("permissionsRemove", () => {
  it("removes a tool by bare name and reports success", () => {
    const actions: TuiAction[] = []
    let removed: string | null = null
    permissionsRemove(
      {
        dispatch: (a) => actions.push(a),
        config,
        home: "/home",
        removeApproval: (_h, tool) => {
          removed = tool
          return true
        },
      },
      "bash"
    )
    expect(removed).toBe("mcp__cognia-tools__bash")
    if (actions[0].type === "NOTICE") expect(actions[0].message).toMatch(/Removed always-allow/)
  })

  it("reports when there was no entry, and rejects an empty name", () => {
    const actions: TuiAction[] = []
    permissionsRemove(
      { dispatch: (a) => actions.push(a), config, home: "/home", removeApproval: () => false },
      "write"
    )
    if (actions[0].type === "NOTICE") expect(actions[0].message).toMatch(/No always-allow entry/)
    permissionsRemove(
      { dispatch: (a) => actions.push(a), config, home: "/home", removeApproval: () => false },
      "  "
    )
    if (actions[1].type === "NOTICE") expect(actions[1].message).toMatch(/Usage:/)
  })
})

describe("permissionsClear", () => {
  it("clears and reports the count", () => {
    const actions: TuiAction[] = []
    permissionsClear({
      dispatch: (a) => actions.push(a),
      config,
      home: "/home",
      clearApprovals: () => 3,
    })
    if (actions[0].type === "NOTICE") expect(actions[0].message).toMatch(/Cleared 3 .*tools/)
  })

  it("reports nothing-to-clear when empty", () => {
    const actions: TuiAction[] = []
    permissionsClear({
      dispatch: (a) => actions.push(a),
      config,
      home: "/home",
      clearApprovals: () => 0,
    })
    if (actions[0].type === "NOTICE") expect(actions[0].message).toMatch(/No always-allowed tools/)
  })
})
