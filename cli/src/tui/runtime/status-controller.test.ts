/**
 * @jest-environment node
 */
import { collectStatusReport, runStatus, type StatusDeps } from "./status-controller"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import { builtinCapabilities, externalCapabilities } from "./backend-capabilities"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  provider: "anthropic",
  model: "claude-x",
  // Per-provider slot mirrors the resolved config — `resolveActiveModel` (which
  // the status report now reads) returns this, not the legacy top-level pin.
  providers: { anthropic: { model: "claude-x" } },
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
    // "claude-x" matches no pattern → 128k default → 78%.
    expect(report.contextWindow).toBe(128_000)
    expect(report.contextPct).toBe(78)
  })
})

describe("collectStatusReport — backend", () => {
  it("reports the built-in backend and claims no blocked features", () => {
    const report = collectStatusReport(deps())
    // The field was collected but dropped before, so `/status` showed the
    // built-in provider while an external agent was answering.
    expect(report.agentBackend).toBe("builtin")
    expect(report.provider).toBe("anthropic")
    expect(report.blockedFeatures).toBeUndefined()
  })

  it("names the external agent and what it cannot do", () => {
    const report = collectStatusReport(
      deps({
        config: { ...config, agentBackend: "codex" },
        capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
      })
    )
    expect(report.agentBackend).toBe("codex")
    expect(report.provider).toBe("codex (codex-app-server)")
    expect(report.blockedFeatures).toEqual(
      expect.arrayContaining(["Context compaction", "Rate limits", "Lifecycle hooks"])
    )
    // …and the bridged ones are NOT listed as blocked.
    expect(report.blockedFeatures).not.toContain("MCP servers")
    expect(report.blockedFeatures).not.toContain("Thinking level")
  })

  it("never borrows the built-in provider's model or window for an external agent", () => {
    // The regression: `config.model`/`resolveActiveModel` are the anthropic
    // view, so the panel reported "claude-x" at 78% of a 128k window while
    // Codex was answering.
    const report = collectStatusReport(
      deps({
        config: { ...config, agentBackend: "codex" },
        capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
        usage: { inputTokens: 100_000 },
      })
    )
    expect(report.model).toBe("(agent default)")
    expect(report.modelValid).toBe(true)
    expect(report.contextWindow).toBeUndefined()
    expect(report.contextPct).toBeUndefined()
    // The token count is measured, not inferred, so it survives.
    expect(report.contextTokens).toBe(100_000)
  })

  it("reports the model the external backend was actually told to run", () => {
    const report = collectStatusReport(
      deps({
        config: {
          ...config,
          agentBackend: "codex",
          agentBackends: { "codex-app-server": { model: "gpt-5.2-codex" } },
        },
        capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
        usage: { inputTokens: 100_000 },
        contextWindow: 400_000,
      })
    )
    expect(report.model).toBe("gpt-5.2-codex")
    // A resolved window is a real fact, so the gauge comes back — sized by it.
    expect(report.contextWindow).toBe(400_000)
    expect(report.contextPct).toBe(25)
  })

  it("lists nothing as blocked on the built-in capability set", () => {
    const report = collectStatusReport(deps({ capabilities: builtinCapabilities() }))
    expect(report.blockedFeatures).toEqual([])
  })
})

describe("runStatus", () => {
  it("opens the status overlay with the report", () => {
    const d = deps()
    runStatus(d)
    expect(d.actions[0]).toMatchObject({ type: "OVERLAY_OPEN", overlay: { kind: "status" } })
  })
})
