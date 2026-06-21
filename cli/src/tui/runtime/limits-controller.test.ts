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
    | Extract<TuiAction, { type: "OVERLAY_OPEN" }>
    | undefined
  return a && a.overlay.kind === "limits" ? a.overlay : null
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
  it("opens the limits panel with the loaded snapshots + session analysis", async () => {
    const loadLimits = jest.fn(async () => [snap("anthropic"), snap("moonshot")])
    const d = deps({
      loadLimits,
      usageHistory: [200_000, 10_000],
      toolStats: { bash: { calls: 3, errors: 0 }, dispatch_agent: { calls: 1, errors: 0 } },
    })
    await runLimits(d)
    expect(loadLimits).toHaveBeenCalledWith(d.config, NOW)
    const overlay = openedLimits(d.actions)
    expect(overlay?.snapshots.map((s) => s.provider)).toEqual(["anthropic", "moonshot"])
    expect(overlay?.analysis.turns).toBe(2)
    expect(overlay?.analysis.dispatchCalls).toBe(1)
  })

  it("opens an empty panel when no provider yields data", async () => {
    const d = deps({ loadLimits: async () => [] })
    await runLimits(d)
    expect(openedLimits(d.actions)?.snapshots).toEqual([])
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
    await expect(runLimits(d)).resolves.toBeUndefined()
    const snaps = openedLimits(d.actions)?.snapshots ?? []
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ accountId: "x", provider: "x", meters: [] })
  })

  it("threads the active provider id onto the overlay for the `● active` badge", async () => {
    const d = deps({ loadLimits: async () => [snap("anthropic"), snap("moonshot")] })
    await runLimits(d)
    expect(openedLimits(d.actions)?.activeProvider).toBe("anthropic")
  })
})
