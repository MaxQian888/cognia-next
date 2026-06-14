import { resolveChannels, localTimeZone } from "./routing"
import { resolvePreferences } from "./preferences"
import type { NotificationPreferences } from "@/types/notifications"

const base = (over: Partial<NotificationPreferences> = {}): NotificationPreferences =>
  resolvePreferences({ globalDefaultChannels: ["center", "toast", "os", "push"], ...over })

describe("resolveChannels", () => {
  it("keeps center plus the global default channels", () => {
    const d = resolveChannels({ source: "system", level: "info" }, base(), 0, "UTC")
    expect(d.channels).toContain("center")
    expect(d.channels).toEqual(
      ["center", "toast", "os", "push"].filter((c) => d.channels.includes(c as never))
    )
  })

  it("gates OS below minOsLevel but never drops center", () => {
    const prefs = base({ minOsLevel: "error" })
    const d = resolveChannels({ source: "system", level: "info" }, prefs, 0, "UTC")
    expect(d.channels).not.toContain("os")
    expect(d.channels).toContain("center")
  })

  it("gates push below minPushLevel", () => {
    const prefs = base({ minPushLevel: "critical" })
    const d = resolveChannels({ source: "system", level: "warning" }, prefs, 0, "UTC")
    expect(d.channels).not.toContain("push")
  })

  it("a muted source records to center only", () => {
    const prefs = base({ perSource: { plugin: { enabled: false } } })
    const d = resolveChannels({ source: "plugin", level: "warning" }, prefs, 0, "UTC")
    expect(d.channels).toEqual(["center"])
  })

  it("critical bypasses mute, gates, and DND (forces toast+os)", () => {
    const prefs = base({
      perSource: { plugin: { enabled: false } },
      minOsLevel: "critical",
      quietHours: { enabled: true, start: "00:00", end: "23:59" },
    })
    const d = resolveChannels({ source: "plugin", level: "critical" }, prefs, 0, "UTC")
    expect(d.channels).toEqual(expect.arrayContaining(["center", "toast", "os"]))
    expect(d.suppressedByDnd).toBe(false)
  })

  it("DND strips toast/os/push but keeps center", () => {
    const prefs = base({ quietHours: { enabled: true, start: "00:00", end: "23:59" } })
    const d = resolveChannels({ source: "system", level: "warning" }, prefs, 0, "UTC")
    expect(d.suppressedByDnd).toBe(true)
    expect(d.channels).toEqual(["center"])
  })

  it("DND strips the im channel but keeps center", () => {
    const prefs = base({ quietHours: { enabled: true, start: "00:00", end: "23:59" } })
    const d = resolveChannels(
      { source: "connector", level: "warning", channels: ["center", "im"] },
      prefs,
      0,
      "UTC"
    )
    expect(d.suppressedByDnd).toBe(true)
    expect(d.channels).toEqual(["center"])
  })

  it("critical keeps a requested im channel through DND", () => {
    const prefs = base({ quietHours: { enabled: true, start: "00:00", end: "23:59" } })
    const d = resolveChannels(
      { source: "connector", level: "critical", channels: ["center", "im"] },
      prefs,
      0,
      "UTC"
    )
    expect(d.channels).toContain("im")
  })

  it("routes the im channel when the caller requests it (no DND)", () => {
    const d = resolveChannels(
      { source: "connector", level: "info", channels: ["center", "im"] },
      base(),
      0,
      "UTC"
    )
    expect(d.channels).toContain("im")
  })

  it("DND disabled does not suppress", () => {
    const prefs = base({ quietHours: { enabled: false, start: "00:00", end: "23:59" } })
    const d = resolveChannels({ source: "system", level: "warning" }, prefs, 0, "UTC")
    expect(d.suppressedByDnd).toBe(false)
    expect(d.channels).toContain("toast")
  })

  it("caller channel override is authoritative (center always survives)", () => {
    const d = resolveChannels(
      { source: "system", level: "warning", channels: ["toast"] },
      base(),
      0,
      "UTC"
    )
    expect(d.channels.sort()).toEqual(["center", "toast"])
  })

  it("caller override can add OS even when the global default omits it", () => {
    const prefs = base({ globalDefaultChannels: ["center", "toast"] })
    const d = resolveChannels(
      { source: "scheduler", level: "warning", channels: ["center", "os"] },
      prefs,
      0,
      "UTC"
    )
    expect(d.channels).toContain("os")
  })

  it("caller override is still subject to level gates and DND", () => {
    const gated = resolveChannels(
      { source: "scheduler", level: "info", channels: ["center", "os"] },
      base({ minOsLevel: "error" }),
      0,
      "UTC"
    )
    expect(gated.channels).not.toContain("os")
  })

  it("per-source channel override replaces the global default", () => {
    const prefs = base({ perSource: { connector: { enabled: true, channels: ["center", "os"] } } })
    const d = resolveChannels({ source: "connector", level: "warning" }, prefs, 0, "UTC")
    expect(d.channels.sort()).toEqual(["center", "os"])
  })

  it("per-source minOsLevel overrides the global gate", () => {
    const prefs = base({
      minOsLevel: "info",
      perSource: { connector: { enabled: true, minOsLevel: "error" } },
    })
    const d = resolveChannels({ source: "connector", level: "warning" }, prefs, 0, "UTC")
    expect(d.channels).not.toContain("os")
  })
})

describe("localTimeZone", () => {
  it("returns a non-empty IANA string", () => {
    expect(typeof localTimeZone()).toBe("string")
    expect(localTimeZone().length).toBeGreaterThan(0)
  })
})
