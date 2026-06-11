/**
 * @jest-environment node
 */
import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"
import { runLimits, type LimitsDeps } from "./limits-controller"

// Mock the network probe so the default (non-injected) probe path is covered
// without a real fetch.
jest.mock("@/lib/subscription/anthropic/usage-probe", () => ({
  probeOnce: jest.fn(),
}))
const mockProbeOnce = probeOnce as jest.MockedFunction<typeof probeOnce>
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import type { UsageSnapshot } from "@/types/subscription"

const NOW = 1_700_000_000_000

function snapshot(): UsageSnapshot {
  return {
    fetchedAt: NOW,
    source: "probe",
    status: "allowed",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.1, resetAt: NOW + 60 * 60 * 1000, status: "allowed" },
    sevenDay: { utilization: 0.2, resetAt: NOW + 24 * 60 * 60 * 1000, status: "allowed" },
    fallbackPercentage: null,
    overageDisabledReason: null,
    rawHeaders: {},
  }
}

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

function openedDoc(actions: TuiAction[]): { title: string; body: string } | null {
  const a = actions.find((x) => x.type === "OVERLAY_OPEN") as
    | Extract<TuiAction, { type: "OVERLAY_OPEN" }>
    | undefined
  if (!a || a.overlay.kind !== "document") return null
  return { title: a.overlay.title, body: a.overlay.body }
}

describe("runLimits", () => {
  it("probes and opens a document overlay with both windows", async () => {
    const probe = jest.fn(async () => snapshot())
    const d = deps({
      probe,
      usageHistory: [200_000, 10_000],
      toolStats: { bash: { calls: 3, errors: 0 }, dispatch_agent: { calls: 1, errors: 0 } },
    })
    await runLimits(d)
    expect(probe).toHaveBeenCalledWith("tok")
    const doc = openedDoc(d.actions)
    expect(doc?.title).toBe("Usage & limits")
    expect(doc?.body).toContain("Current session (5h)")
    expect(doc?.body).toContain("10% used")
    expect(doc?.body).toContain("Turns this session: 2")
    expect(doc?.body).toContain("1 subagent dispatch")
  })

  it("renders the no-subscription note when no anthropic token is configured", async () => {
    const probe = jest.fn(async () => snapshot())
    const config: ResolvedConfig = {
      ...DEFAULT_RESOLVED_CONFIG,
      provider: "deepseek",
      cwd: "/w",
      providers: {},
    }
    const d = deps({ config, probe })
    await runLimits(d)
    expect(probe).not.toHaveBeenCalled()
    expect(openedDoc(d.actions)?.body).toContain("No subscription limit data")
  })

  it("degrades to no-snapshot when the probe fails", async () => {
    const d = deps({
      probe: jest.fn(async () => null),
      anthropicToken: "tok",
    })
    await runLimits(d)
    expect(openedDoc(d.actions)?.body).toContain("No subscription limit data")
  })

  it("never throws when the probe rejects", async () => {
    const d = deps({
      probe: jest.fn(async () => {
        throw new Error("network")
      }),
    })
    await expect(runLimits(d)).resolves.toBeUndefined()
    expect(openedDoc(d.actions)?.body).toContain("No subscription limit data")
  })

  it("uses the default probe (probeOnce) when none is injected", async () => {
    mockProbeOnce.mockResolvedValueOnce({ ok: true, snapshot: snapshot() })
    // No `probe` and no `now` injected → exercises defaultProbe + default clock.
    const d = deps({ probe: undefined, now: undefined })
    await runLimits(d)
    expect(mockProbeOnce).toHaveBeenCalledWith({ accessToken: "tok" })
    expect(openedDoc(d.actions)?.body).toContain("Current session (5h)")
  })

  it("treats a failed default probe as no snapshot", async () => {
    mockProbeOnce.mockResolvedValueOnce({ ok: false, reason: "auth", status: 401 })
    const d = deps({ probe: undefined })
    await runLimits(d)
    expect(openedDoc(d.actions)?.body).toContain("No subscription limit data")
  })
})
