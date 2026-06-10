import { buildPermissionsReport, permissionsClear, permissionsList } from "./permissions-controller"
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

  it("lists always-allowed tools de-namespaced and sorted", () => {
    const r = buildPermissionsReport("acceptEdits", 30, [
      "mcp__cognia-tools__write",
      "mcp__cognia-tools__bash",
    ])
    expect(r).toContain("Always-allowed (2):")
    expect(r.indexOf("• bash")).toBeLessThan(r.indexOf("• write"))
    expect(r).toContain("/permissions clear")
  })
})

describe("permissionsList", () => {
  it("dispatches a notice from the resolved approvals", () => {
    const actions: TuiAction[] = []
    permissionsList({
      dispatch: (a) => actions.push(a),
      config,
      home: "/home",
      readApprovals: () => new Set(["mcp__cognia-tools__bash"]),
    })
    expect(actions).toHaveLength(1)
    if (actions[0].type === "NOTICE") expect(actions[0].message).toContain("• bash")
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
