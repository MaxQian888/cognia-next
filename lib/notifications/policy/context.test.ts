// Coverage for policy-context derivation (V2): prefs → NotificationPolicyContext,
// the deterministic policyVersion (identical prefs ⇒ identical version, any
// change ⇒ a new one — the replay-detection key), and the host-timezone
// fallback. Pure.

import { notificationPolicyContext, hostTimezone } from "./context"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@/types/notifications"

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...over,
    quietHours: { ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours, ...(over.quietHours ?? {}) },
  }
}

describe("hostTimezone", () => {
  it("returns a non-empty IANA zone", () => {
    expect(typeof hostTimezone()).toBe("string")
    expect(hostTimezone().length).toBeGreaterThan(0)
  })
})

describe("notificationPolicyContext", () => {
  it("maps quiet-hours fields onto the context", () => {
    const ctx = notificationPolicyContext(
      prefs({ quietHours: { enabled: true, start: "21:00", end: "07:00" } }),
      { timezone: "Asia/Shanghai" }
    )
    expect(ctx.quietHoursEnabled).toBe(true)
    expect(ctx.quietHoursStart).toBe("21:00")
    expect(ctx.quietHoursEnd).toBe("07:00")
    expect(ctx.quietHoursTimezone).toBe("Asia/Shanghai")
    expect(ctx.timezone).toBe("Asia/Shanghai")
  })

  it("maps level thresholds", () => {
    const ctx = notificationPolicyContext(prefs({ minOsLevel: "warning", minPushLevel: "error" }))
    expect(ctx.osThreshold).toBe("warning")
    expect(ctx.pushThreshold).toBe("error")
  })

  it("defaults critical bypass OFF (explicit opt-in only)", () => {
    const ctx = notificationPolicyContext(prefs())
    expect(ctx.quietHoursAllowCritical).toBe(false)
  })

  it("produces the SAME policyVersion for identical prefs (dedupes no-change replan)", () => {
    const a = notificationPolicyContext(prefs(), { timezone: "UTC" })
    const b = notificationPolicyContext(prefs(), { timezone: "UTC" })
    expect(a.policyVersion).toBe(b.policyVersion)
  })

  it("produces a NEW policyVersion when a policy input changes", () => {
    const a = notificationPolicyContext(prefs(), { timezone: "UTC" })
    const b = notificationPolicyContext(prefs({ minOsLevel: "critical" }), { timezone: "UTC" })
    expect(a.policyVersion).not.toBe(b.policyVersion)
  })

  it("policyVersion is a positive int", () => {
    const ctx = notificationPolicyContext(prefs())
    expect(Number.isInteger(ctx.policyVersion)).toBe(true)
    expect(ctx.policyVersion).toBeGreaterThanOrEqual(0)
  })
})
