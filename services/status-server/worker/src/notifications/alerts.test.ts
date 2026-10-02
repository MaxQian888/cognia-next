import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { T0, baseEnv, count, resetOwnerE } from "../admin/test-support"
import { alertOperator } from "./index"

describe("alertOperator", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("posts to the fixed webhook once per cooldown", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
    const env = { ...baseEnv, OPERATOR_ALERT_WEBHOOK: "https://alerts.example.test/hook" }
    const alert = {
      key: "observer:ext-1",
      severity: "warning" as const,
      summary: "stale",
      nowMs: T0,
      cooldownMs: 600_000,
    }
    await alertOperator(env, alert)
    await alertOperator(env, { ...alert, nowMs: T0 + 60_000 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await alertOperator(env, { ...alert, nowMs: T0 + 600_000 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("only logs without a (valid HTTPS) webhook, and survives webhook failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"))
    await alertOperator(baseEnv, { key: "a", severity: "critical", summary: "x", nowMs: T0 })
    await alertOperator(
      { ...baseEnv, OPERATOR_ALERT_WEBHOOK: "http://insecure.example" },
      { key: "b", severity: "critical", summary: "x", nowMs: T0 }
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    await alertOperator(
      { ...baseEnv, OPERATOR_ALERT_WEBHOOK: "https://alerts.example.test" },
      { key: "c", severity: "critical", summary: "x", nowMs: T0 }
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await count("operator_alerts")).toBe(3)
  })
})
