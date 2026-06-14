import { runCustomLimitsSource } from "./runner"
import { isCustomSourceComplete } from "./store"
import { CUSTOM_SOURCE_PRESETS, NEW_API_QUOTA_SCALE, presetById } from "./presets"

import type { CustomLimitsSource } from "@/types/subscription"

/** A draft carrying only the user-supplied identity fields a preset preserves. */
function draft(over: Partial<CustomLimitsSource> = {}): CustomLimitsSource {
  return {
    id: "src1",
    name: "My Source",
    baseUrl: "https://relay.example.com",
    token: "tok-123",
    request: { path: "" },
    extract: { kind: "balance", remainingPath: "" },
    ...over,
  }
}

const NOW = 1_700_000_000_000

function deps(body: string) {
  return { authedGet: jest.fn(async () => body), now: () => NOW }
}

describe("custom source presets", () => {
  it("exposes the catalog with 'custom' first as a no-op", () => {
    expect(CUSTOM_SOURCE_PRESETS[0].id).toBe("custom")
    const d = draft({ request: { path: "/keep" } })
    expect(presetById("custom").apply(d)).toBe(d)
  })

  it("presetById falls back to the no-op custom preset for unknown ids", () => {
    expect(presetById("does-not-exist").id).toBe("custom")
  })

  it("every preset preserves identity fields and yields a complete source", () => {
    for (const preset of CUSTOM_SOURCE_PRESETS) {
      if (preset.id === "custom") continue
      const applied = preset.apply(draft())
      expect(applied.id).toBe("src1")
      expect(applied.name).toBe("My Source")
      expect(applied.baseUrl).toBe("https://relay.example.com")
      expect(applied.token).toBe("tok-123")
      expect(isCustomSourceComplete(applied)).toBe(true)
    }
  })

  describe("new-api relay", () => {
    const preset = presetById("new-api")

    it("fills the /api/user/self balance template with the quota scale", () => {
      const applied = preset.apply(draft())
      expect(applied.request.path).toBe("/api/user/self")
      expect(applied.request.headers).toMatchObject({ "New-Api-User": "" })
      expect(applied.extract).toMatchObject({
        kind: "balance",
        remainingPath: "data.quota",
        usedPath: "data.used_quota",
        scale: NEW_API_QUOTA_SCALE,
        currency: "USD",
      })
    })

    it("scales internal quota units to USD via the engine", async () => {
      const body = JSON.stringify({ data: { quota: 2_500_000, used_quota: 500_000 } })
      const snap = await runCustomLimitsSource(preset.apply(draft()), deps(body))
      expect(snap?.meters).toHaveLength(1)
      const meter = snap!.meters[0]
      expect(meter.kind).toBe("balance")
      expect(meter.remaining).toBeCloseTo(5) // 2_500_000 / 500_000
      expect(meter.used).toBeCloseTo(1) // 500_000 / 500_000
      expect(meter.currency).toBe("USD")
    })
  })

  describe("generic balance", () => {
    it("derives remaining from data.balance", async () => {
      const applied = presetById("generic-balance").apply(draft())
      expect(applied.request.path).toBe("/user/balance")
      const body = JSON.stringify({ data: { balance: 12.5, total_balance: 20 } })
      const snap = await runCustomLimitsSource(applied, deps(body))
      expect(snap?.meters[0]).toMatchObject({ kind: "balance", remaining: 12.5, total: 20 })
    })
  })

  describe("coding-plan-count", () => {
    it("derives utilization from used/total counts", async () => {
      const applied = presetById("coding-plan-count").apply(draft())
      expect(applied.extract.kind).toBe("window")
      const body = JSON.stringify({ data: { used: 30, total: 100, reset_at: 1_800_000_000 } })
      const snap = await runCustomLimitsSource(applied, deps(body))
      const meter = snap!.meters[0]
      expect(meter.kind).toBe("window")
      expect(meter.usedPct).toBe(30)
      expect(meter.resetAt).toBe(1_800_000_000 * 1000)
    })
  })

  describe("github-copilot", () => {
    const preset = presetById("github-copilot")

    it("uses token auth and inverts percent_remaining", async () => {
      const applied = preset.apply(draft({ baseUrl: "https://api.github.com" }))
      expect(applied.request.path).toBe("/copilot_internal/user")
      expect(applied.request.headers?.Authorization).toBe("token {{token}}")
      const body = JSON.stringify({
        quota_snapshots: { premium_interactions: { percent_remaining: 75 } },
        quota_reset_date: "2026-07-01T00:00:00Z",
      })
      const d = deps(body)
      const snap = await runCustomLimitsSource(applied, d)
      const meter = snap!.meters[0]
      expect(meter.kind).toBe("window")
      expect(meter.usedPct).toBe(25) // 100 - 75 remaining
      expect(meter.resetAt).toBe(Date.parse("2026-07-01T00:00:00Z"))
      // Token substituted into the raw `token …` Authorization header.
      expect(d.authedGet).toHaveBeenCalledWith(
        "https://api.github.com/copilot_internal/user",
        expect.objectContaining({ Authorization: "token tok-123" })
      )
    })
  })
})
