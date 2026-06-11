/**
 * @jest-environment node
 */
import { collectStatusReport, runStatus, type StatusDeps } from "./status-controller"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  provider: "anthropic",
  model: "claude-x",
  cwd: "/work",
}

function deps(over: Partial<StatusDeps> = {}): StatusDeps & { actions: TuiAction[] } {
  const actions: TuiAction[] = []
  return {
    dispatch: (a: TuiAction) => actions.push(a),
    config,
    home: "/home",
    version: "9.9.9",
    listCredentialed: () => ["anthropic", "openai"],
    fileExists: () => true,
    modelCatalog: () => ["claude-x"],
    readBranch: () => "main",
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0 },
    actions,
    ...over,
  }
}

describe("collectStatusReport", () => {
  it("assembles provider/model/auth/git/context facts", () => {
    const report = collectStatusReport(deps())
    expect(report.version).toBe("9.9.9")
    expect(report.provider).toBe("anthropic")
    expect(report.model).toBe("claude-x")
    expect(report.modelValid).toBe(true)
    expect(report.credentialedProviders).toEqual(["anthropic", "openai"])
    expect(report.gitBranch).toBe("main")
    expect(report.cwd).toBe("/work")
    expect(report.dbSnapshotExists).toBe(true)
    expect(report.contextWindow).toBeGreaterThan(0)
    expect(report.contextPct).toBeGreaterThanOrEqual(0)
  })

  it("flags a model that's not in the catalog", () => {
    const report = collectStatusReport(deps({ modelCatalog: () => ["other"] }))
    expect(report.modelValid).toBe(false)
  })

  it("reports a null branch outside a repo", () => {
    expect(collectStatusReport(deps({ readBranch: () => null })).gitBranch).toBeNull()
  })

  it("uses the per-model context window override for the gauge", () => {
    const report = collectStatusReport(
      deps({ usage: { inputTokens: 100_000 }, contextWindow: 1_000_000 })
    )
    expect(report.contextWindow).toBe(1_000_000)
    expect(report.contextPct).toBe(10)
  })

  it("falls back to the pattern table when no override is given", () => {
    const report = collectStatusReport(deps({ usage: { inputTokens: 100_000 } }))
    // "claude-x" matches no pattern → 200k default → 50%.
    expect(report.contextWindow).toBe(200_000)
    expect(report.contextPct).toBe(50)
  })
})

describe("runStatus", () => {
  it("opens the status overlay with the report", () => {
    const d = deps()
    runStatus(d)
    expect(d.actions[0]).toMatchObject({ type: "OVERLAY_OPEN", overlay: { kind: "status" } })
  })
})
