import {
  computePiContextBudget,
  piBudgetDelta,
  piBudgetLevel,
  PI_TOOL_BUDGET_ADVISORY,
} from "./budget"

describe("computePiContextBudget", () => {
  it("is all zeroes for an empty install", () => {
    const budget = computePiContextBudget([])
    expect(budget).toMatchObject({ staticTokens: 0, toolCount: 0, unknownSpecs: [], rows: [] })
    expect(budget.spawningPackages).toEqual([])
  })

  it("sums static tokens and tool schemas across known packages", () => {
    const budget = computePiContextBudget([
      "npm:pi-mcp-adapter@2.23.0", // 1 tool / 200
      "npm:@narumitw/pi-plan-mode@0.49.3", // 3 tools / 600
    ])
    expect(budget.toolCount).toBe(4)
    expect(budget.staticTokens).toBe(800)
  })

  it("charges a zero-tool footer nothing", () => {
    const budget = computePiContextBudget(["npm:@narumitw/pi-statusline@0.49.6"])
    expect(budget.toolCount).toBe(0)
    expect(budget.staticTokens).toBe(0)
  })

  /**
   * Spawned contexts are reported separately rather than folded into a token
   * count, because one subagent task is a whole new paid context — summing it
   * as tokens would understate it by orders of magnitude.
   */
  it("reports context-spawning packages as their own dimension", () => {
    const budget = computePiContextBudget([
      "npm:@narumitw/pi-subagents@1.0.0",
      "npm:@narumitw/pi-goal@0.51.0",
    ])
    expect(budget.spawningPackages.map((e) => e.id).sort()).toEqual([
      "narumitw-pi-goal",
      "narumitw-pi-subagents",
    ])
  })

  it("counts unreviewed packages separately instead of assuming they are free", () => {
    const budget = computePiContextBudget(["npm:mystery-ext@1.0.0"])
    expect(budget.unknownSpecs).toEqual(["npm:mystery-ext@1.0.0"])
    expect(budget.staticTokens).toBe(0)
    expect(budget.rows).toEqual([])
  })

  it("orders the breakdown by static cost, largest first", () => {
    const budget = computePiContextBudget([
      "npm:@narumitw/pi-statusline@0.49.6",
      "npm:pi-memory@0.4.2",
      "npm:pi-mcp-adapter@2.23.0",
    ])
    expect(budget.rows.map((r) => r.id)).toEqual([
      "pi-memory",
      "pi-mcp-adapter",
      "narumitw-pi-statusline",
    ])
  })

  it("does not double-count a package pinned twice", () => {
    const once = computePiContextBudget(["npm:pi-memory@0.4.2"])
    const twice = computePiContextBudget(["npm:pi-memory@0.4.2", "npm:pi-memory@0.4.0"])
    expect(twice.staticTokens).toBe(once.staticTokens)
  })

  it("prices the avoid-tier always-injected memory package as the catalog's worst", () => {
    const budget = computePiContextBudget(["npm:@vtstech/pi-long-term-memory@1.3.5"])
    expect(budget.staticTokens).toBe(4000)
  })
})

describe("piBudgetLevel", () => {
  it("is ok well under the advisory ceiling", () => {
    expect(piBudgetLevel({ toolCount: 5 })).toBe("ok")
  })

  it("warns approaching the ceiling", () => {
    expect(piBudgetLevel({ toolCount: Math.ceil(PI_TOOL_BUDGET_ADVISORY * 0.8) })).toBe("warn")
  })

  it("is over past the ceiling", () => {
    expect(piBudgetLevel({ toolCount: PI_TOOL_BUDGET_ADVISORY + 1 })).toBe("over")
  })
})

describe("piBudgetDelta", () => {
  it("reports what a new package would add", () => {
    expect(piBudgetDelta("npm:pi-memory@0.4.2", [])).toEqual({
      staticTokens: 1400,
      toolCount: 7,
      spawnsContexts: false,
    })
  })

  it("is zero for a package that is already installed", () => {
    expect(piBudgetDelta("npm:pi-memory@0.4.2", ["npm:pi-memory@0.4.0"])).toEqual({
      staticTokens: 0,
      toolCount: 0,
      spawnsContexts: false,
    })
  })

  it("flags a candidate that introduces spawned contexts", () => {
    expect(piBudgetDelta("npm:@narumitw/pi-subagents@1.0.0", []).spawnsContexts).toBe(true)
  })

  it("is zero for an unreviewed candidate — cost unmeasured, not free", () => {
    expect(piBudgetDelta("npm:mystery@1.0.0", [])).toEqual({
      staticTokens: 0,
      toolCount: 0,
      spawnsContexts: false,
    })
  })
})
