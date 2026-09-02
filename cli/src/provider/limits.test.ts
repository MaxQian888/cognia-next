/**
 * @jest-environment node
 */
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import type { ProviderLimits } from "@/types/subscription"

import type { ResolvedConfig } from "../config/schema"
import { formatMeterLine, metersForVerb, readProviderLimits } from "./limits"

const CONFIG: ResolvedConfig = {
  provider: "anthropic",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { anthropic: { authToken: "t" }, deepseek: { apiKey: "k" }, openai: { apiKey: "o" } },
  cwd: "/w",
}

const NOW = 1_700_000_000_000

const SNAPSHOTS: ProviderLimits[] = [
  {
    provider: "anthropic",
    accountId: "anthropic",
    accountLabel: "anthropic",
    fetchedAt: NOW,
    meters: [
      { id: "session", kind: "window", usedPct: 42, resetAt: NOW + 90 * 60_000, status: "ok" },
      {
        id: "weekly",
        kind: "window",
        usedPct: 101,
        resetAt: NOW + 3 * 86_400_000,
        status: "exceeded",
      },
    ],
  },
  {
    provider: "deepseek",
    accountId: "deepseek",
    fetchedAt: NOW,
    meters: [
      {
        id: "credit",
        kind: "balance",
        usedPct: null,
        remaining: 12.5,
        total: 20,
        currency: "USD",
        status: "ok",
      },
    ],
  },
  { provider: "openai", accountId: "openai", fetchedAt: NOW, meters: [], error: "HTTP 401" },
]

describe("metersForVerb", () => {
  it("keeps window meters for limits and balance meters for balance", () => {
    const all = SNAPSHOTS.flatMap((s) => s.meters)
    expect(metersForVerb("limits", all).map((m) => m.id)).toEqual(["session", "weekly"])
    expect(metersForVerb("balance", all).map((m) => m.id)).toEqual(["credit"])
  })
})

describe("readProviderLimits", () => {
  const loadLimits = jest.fn(async () => SNAPSHOTS)

  it("runs the shared enumerator once and keeps the verb's meters plus errors", async () => {
    const report = await readProviderLimits({
      config: CONFIG,
      verb: "limits",
      now: () => NOW,
      loadLimits,
    })
    expect(loadLimits).toHaveBeenCalledWith(CONFIG, NOW)
    expect(report.fetchedAt).toBe(NOW)
    expect(report.snapshots.map((s) => s.accountId)).toEqual(["anthropic", "openai"])
    expect(report.snapshots[0]!.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    // The errored snapshot survives with no meters so the failure is visible.
    expect(report.snapshots[1]!.error).toBe("HTTP 401")
    expect(report.silent).toEqual(["deepseek"])
  })

  it("answers balance with the credit meters and names providers without one", async () => {
    const report = await readProviderLimits({
      config: CONFIG,
      verb: "balance",
      now: () => NOW,
      loadLimits,
    })
    expect(report.snapshots.map((s) => s.accountId)).toEqual(["deepseek", "openai"])
    expect(report.silent).toEqual(["anthropic"])
  })

  it("scopes to --provider", async () => {
    const report = await readProviderLimits({
      config: CONFIG,
      verb: "limits",
      providerId: "anthropic",
      now: () => NOW,
      loadLimits,
    })
    expect(report.snapshots.map((s) => s.accountId)).toEqual(["anthropic"])
    expect(report.silent).toEqual([])
  })
})

describe("formatMeterLine", () => {
  it("renders windows with percent and reset, balances with amounts", () => {
    const [session, weekly] = SNAPSHOTS[0]!.meters
    const credit = SNAPSHOTS[1]!.meters[0]!
    expect(formatMeterLine(session!, NOW)).toBe(
      "session             42% used  [ok]  resets in 90 min"
    )
    expect(formatMeterLine(weekly!, NOW)).toMatch(
      /^weekly\s+101% used\s+\[exceeded\]\s+resets in 4320 min$/
    )
    expect(formatMeterLine(credit, NOW)).toBe(
      "credit             12.50 USD of 20 USD remaining  [ok]"
    )
  })
})
