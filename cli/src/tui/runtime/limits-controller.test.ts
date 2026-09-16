/**
 * @jest-environment node
 */
import { runLimits, type LimitsDeps } from "./limits-controller"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import type { ProviderLimits } from "@/types/subscription"

const NOW = 1_700_000_000_000

function deps(over: Partial<LimitsDeps> = {}): LimitsDeps & { actions: TuiAction[] } {
  const actions: TuiAction[] = []
  const config: ResolvedConfig = {
    ...DEFAULT_RESOLVED_CONFIG,
    provider: "anthropic",
    cwd: "/work",
    providers: { anthropic: { authToken: "tok" } },
  }
  return {
    dispatch: (a) => actions.push(a),
    config,
    now: () => NOW,
    actions,
    ...over,
  }
}

function openedLimits(actions: TuiAction[]) {
  const a = actions.find((x) => x.type === "OVERLAY_OPEN") as
    Extract<TuiAction, { type: "OVERLAY_OPEN" }> | undefined
  return a && a.overlay.kind === "limits" ? a.overlay : null
}

function loadedLimits(actions: TuiAction[]) {
  return actions.find((action) => action.type === "LIMITS_LOADED") as
    Extract<TuiAction, { type: "LIMITS_LOADED" }> | undefined
}

function snap(provider: string): ProviderLimits {
  return {
    provider,
    accountId: provider,
    fetchedAt: NOW,
    meters: [{ id: "session", kind: "window", usedPct: 10, resetAt: NOW + 3600_000, status: "ok" }],
  }
}

describe("runLimits", () => {
  it("reads native Codex quota instead of the saved built-in provider", async () => {
    const loadLimits = jest.fn(async () => [snap("deepseek")])
    const loadCodexLimits = jest.fn(async () => [snap("codex")])
    const d = deps({
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        provider: "deepseek",
        agentBackend: "codex",
        cwd: "/work",
      },
      presetId: "codex-app-server",
      backendAgentId: "live-codex",
      loadLimits,
      loadCodexLimits,
      rateLimits: { provider: "deepseek" } as never,
    })
    runLimits(d)
    await Promise.resolve()
    expect(openedLimits(d.actions)).toMatchObject({
      activeProvider: "codex",
      rateLimits: undefined,
    })
    expect(loadCodexLimits).toHaveBeenCalledWith("live-codex", NOW, d.config.locale)
    expect(loadLimits).not.toHaveBeenCalled()
    expect(loadedLimits(d.actions)?.snapshots).toEqual([snap("codex")])
  })

  it("keeps a disconnected external backend unknown without querying provider credentials", async () => {
    const loadLimits = jest.fn(async () => [snap("deepseek")])
    const d = deps({
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        provider: "deepseek",
        agentBackend: "codex-app-server",
        cwd: "/work",
      },
      loadLimits,
    })
    runLimits(d)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openedLimits(d.actions)?.activeProvider).toBe("codex")
    expect(loadLimits).not.toHaveBeenCalled()
    expect(loadedLimits(d.actions)?.snapshots).toEqual([
      expect.objectContaining({ provider: "codex", meters: [] }),
    ])
  })

  it("opens a loading panel immediately and does not block while providers load", async () => {
    let resolveLimits!: (snapshots: ProviderLimits[]) => void
    const pending = new Promise<ProviderLimits[]>((resolve) => {
      resolveLimits = resolve
    })
    const d = deps({ loadLimits: () => pending })

    runLimits(d)

    expect(openedLimits(d.actions)).toMatchObject({
      snapshots: [],
      loading: true,
      activeProvider: "anthropic",
    })
    resolveLimits([snap("anthropic")])
    await Promise.resolve()
    expect(loadedLimits(d.actions)).toMatchObject({
      requestId: openedLimits(d.actions)?.requestId,
      snapshots: [snap("anthropic")],
    })
  })

  it("opens the limits panel with the loaded snapshots + session analysis", async () => {
    const loadLimits = jest.fn(async () => [snap("anthropic"), snap("moonshot")])
    const d = deps({
      loadLimits,
      usageHistory: [200_000, 10_000],
      toolStats: { bash: { calls: 3, errors: 0 }, dispatch_agent: { calls: 1, errors: 0 } },
    })
    runLimits(d)
    await Promise.resolve()
    expect(loadLimits).toHaveBeenCalledWith(d.config, NOW)
    const overlay = openedLimits(d.actions)
    expect(loadedLimits(d.actions)?.snapshots.map((s) => s.provider)).toEqual([
      "anthropic",
      "moonshot",
    ])
    expect(overlay?.analysis.turns).toBe(2)
    expect(overlay?.analysis.dispatchCalls).toBe(1)
  })

  it("opens an empty panel when no provider yields data", async () => {
    const d = deps({ loadLimits: async () => [] })
    runLimits(d)
    await Promise.resolve()
    expect(loadedLimits(d.actions)?.snapshots).toEqual([])
  })

  it("uses the default loader when none is injected (offline → only the active placeholder, never throws)", async () => {
    // No anthropic probe is mocked here and no credit keys are configured; the
    // default loader runs buildCliLimits, whose probes fail → degrades to no data
    // without throwing. The active provider is still surfaced as a no-data
    // placeholder so the panel never collapses to an unrelated credit provider.
    const d = deps({
      loadLimits: undefined,
      now: undefined, // also exercises the default Date.now() clock
      config: { ...DEFAULT_RESOLVED_CONFIG, provider: "x", cwd: "/w", providers: {} },
    })
    runLimits(d)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const snaps = loadedLimits(d.actions)?.snapshots ?? []
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ accountId: "x", provider: "x", meters: [] })
  })

  it("threads the active provider id onto the overlay for the `● active` badge", async () => {
    const d = deps({ loadLimits: async () => [snap("anthropic"), snap("moonshot")] })
    runLimits(d)
    expect(openedLimits(d.actions)?.activeProvider).toBe("anthropic")
  })
})

it("routes the devin backend through the uniform external limits loader", async () => {
  const loadExternalLimits = jest.fn(async () => [snap("devin")])
  const loadLimits = jest.fn(async () => [])
  const d = deps({
    config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "devin" },
    presetId: "devin",
    loadExternalLimits,
    loadLimits,
  })
  runLimits(d)
  await Promise.resolve()
  expect(openedLimits(d.actions)).toMatchObject({ activeProvider: "devin", loading: true })
  expect(loadExternalLimits).toHaveBeenCalledWith(
    d.config,
    NOW,
    "devin",
    "devin",
    "agentLimits.unavailable"
  )
  expect(loadLimits).not.toHaveBeenCalled()
  expect(loadedLimits(d.actions)?.snapshots).toEqual([snap("devin")])
})

it("passes the notConnected notice key when the codex app server is not connected", async () => {
  const loadExternalLimits = jest.fn(async () => [])
  const d = deps({
    config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "codex-app-server" },
    loadExternalLimits,
  })
  runLimits(d)
  await Promise.resolve()
  expect(loadExternalLimits).toHaveBeenCalledWith(
    d.config,
    NOW,
    "codex",
    "codex-app-server",
    "codexLimits.notConnected"
  )
})

it.each(["codex-acp", "pi", "opencode-server"])(
  "%s never queries Codex or configured credential providers",
  async (backend) => {
    const loadCodexLimits = jest.fn(async () => [])
    const loadLimits = jest.fn(async () => [])
    const d = deps({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: backend },
      presetId: backend,
      backendAgentId: "connected",
      loadCodexLimits,
      loadLimits,
    })
    runLimits(d)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loadCodexLimits).not.toHaveBeenCalled()
    expect(loadLimits).not.toHaveBeenCalled()
    expect(loadedLimits(d.actions)?.snapshots[0]).toMatchObject({
      meters: [],
      notice: expect.any(String),
    })
  }
)

it("renders pushed native quotas for Claude and reports when none have arrived", async () => {
  const d = deps({
    config: {
      ...DEFAULT_RESOLVED_CONFIG,
      cwd: "/work",
      agentBackend: "claude-code",
      locale: "zh-CN",
    },
    agentRateLimits: { five_hour: { kind: "rate-limit", status: "allowed", utilization: 0.42 } },
  })
  runLimits(d)
  await Promise.resolve()
  expect(loadedLimits(d.actions)?.snapshots[0].meters[0].usedPct).toBe(42)
  const empty = deps({ config: d.config })
  runLimits(empty)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(loadedLimits(empty.actions)?.snapshots[0].notice).toContain("尚未")
})

it("prefers pushed native SDK quotas over the built-in billable probe", async () => {
  const loadLimits = jest.fn(async () => [])
  const d = deps({
    agentRateLimits: { five_hour: { kind: "rate-limit", status: "allowed", utilization: 0 } },
    loadLimits,
  })
  runLimits(d)
  await Promise.resolve()
  expect(loadLimits).not.toHaveBeenCalled()
  expect(loadedLimits(d.actions)?.snapshots[0].meters[0]).toMatchObject({
    usedPct: 0,
    status: "ok",
  })
})

it.each([new Error("Native quota read failed"), "Native quota read failed"])(
  "shows native quota errors without falling back to credential providers",
  async (error) => {
    const loadLimits = jest.fn(async () => [])
    const d = deps({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "codex-app-server" },
      backendAgentId: "native",
      loadCodexLimits: async () => {
        throw error
      },
      loadLimits,
    })
    runLimits(d)
    await Promise.resolve()
    await Promise.resolve()
    expect(loadedLimits(d.actions)?.snapshots[0]).toMatchObject({
      provider: "codex",
      meters: [],
      error: "Native quota read failed",
    })
    expect(loadLimits).not.toHaveBeenCalled()
  }
)
