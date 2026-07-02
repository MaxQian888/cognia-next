import { deriveTrayTooltip } from "./tooltip"
import type { TrayStateSnapshot } from "./types"

// Identity-ish translator: maps the few status keys to readable strings and
// passes anything else through (mirrors the resilient builder translator).
const T: Record<string, string> = {
  "tray.status.automationRunning": "Automation running",
  "tray.status.goalRunning": "Goal running",
  "tray.status.goalPaused": "Goal paused",
  "tray.status.streaming": "Responding",
  "tray.status.petNeedsAttention": "Pet needs attention",
}
const t = (key: string) => T[key] ?? key

function snap(overrides: Partial<TrayStateSnapshot> = {}): TrayStateSnapshot {
  return {
    goal: { active: false, paused: false },
    automation: { running: false, armed: true },
    chat: { streaming: false, hasActiveSession: false },
    platform: { os: "macos" },
    app: { autostart: false, version: "1.0.0" },
    ...overrides,
  }
}

describe("deriveTrayTooltip", () => {
  it("returns the plain base when idle", () => {
    expect(deriveTrayTooltip(snap(), t)).toBe("Cognia")
  })

  it("honours a custom base", () => {
    expect(deriveTrayTooltip(snap(), t, "My App")).toBe("My App")
  })

  it("appends the localized status while streaming", () => {
    expect(deriveTrayTooltip(snap({ chat: { streaming: true, hasActiveSession: true } }), t)).toBe(
      "Cognia — Responding"
    )
  })

  it("appends the redacted goal objective for an active goal", () => {
    const out = deriveTrayTooltip(
      snap({ goal: { active: true, paused: false, title: "Ship the release" } }),
      t
    )
    expect(out).toBe("Cognia — Goal running: Ship the release")
  })

  it("truncates a long objective in the tooltip", () => {
    const out = deriveTrayTooltip(
      snap({ goal: { active: true, paused: false, title: "x".repeat(80) } }),
      t
    )
    expect(out.endsWith("…")).toBe(true)
    // base + separator + label + colon + 40-char truncated title — well under the OS cap.
    expect(out.length).toBeLessThan(70)
  })

  it("shows automation status without a goal title", () => {
    expect(deriveTrayTooltip(snap({ automation: { running: true, armed: true } }), t)).toBe(
      "Cognia — Automation running"
    )
  })

  it("surfaces the pet needing attention as the lowest-priority status", () => {
    const out = deriveTrayTooltip(snap({ pet: { enabled: true, energy: 5, mood: 5, bond: 50 } }), t)
    expect(out).toBe("Cognia — Pet needs attention")
  })

  it("still lets streaming outrank a needy pet", () => {
    const out = deriveTrayTooltip(
      snap({
        pet: { enabled: true, energy: 5, mood: 5, bond: 50 },
        chat: { streaming: true, hasActiveSession: true },
      }),
      t
    )
    expect(out).toBe("Cognia — Responding")
  })
})
