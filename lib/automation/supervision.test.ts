import type { AuditEntry } from "@/lib/automation/client"

const settingsGet = jest.fn()
const killSwitchEngaged = jest.fn()
const auditSnapshot = jest.fn()
const killSwitch = jest.fn()

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    settingsGet: (...a: unknown[]) => settingsGet(...a),
    killSwitchEngaged: (...a: unknown[]) => killSwitchEngaged(...a),
    auditSnapshot: (...a: unknown[]) => auditSnapshot(...a),
    killSwitch: (...a: unknown[]) => killSwitch(...a),
  },
}))

import { countDecisions, haltAutomation, readAutomationSupervision } from "./supervision"

const entry = (over: Partial<AuditEntry> & { id: string; ts: number }): AuditEntry => ({
  surface: "computerUse",
  pluginId: null,
  command: "desktop_click",
  processName: null,
  windowTitle: null,
  decision: "allow",
  reason: null,
  durationMs: 4,
  error: null,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  settingsGet.mockResolvedValue({ enabled: true, defaultTier: "whitelist" })
  killSwitchEngaged.mockResolvedValue(false)
  auditSnapshot.mockResolvedValue([])
  killSwitch.mockResolvedValue(undefined)
})

describe("countDecisions", () => {
  it("counts each decision and the total", () => {
    expect(
      countDecisions([
        entry({ id: "a", ts: 1 }),
        entry({ id: "b", ts: 2, decision: "deny" }),
        entry({ id: "c", ts: 3, decision: "consent" }),
        entry({ id: "d", ts: 4 }),
      ])
    ).toEqual({ total: 4, allow: 2, deny: 1, consent: 1 })
  })

  it("reports zeroes for an empty ring", () => {
    expect(countDecisions([])).toEqual({ total: 0, allow: 0, deny: 0, consent: 0 })
  })
})

describe("readAutomationSupervision", () => {
  it("reports the engine state alongside the decisions", async () => {
    settingsGet.mockResolvedValue({ enabled: false, defaultTier: "perCall" })
    killSwitchEngaged.mockResolvedValue(true)
    auditSnapshot.mockResolvedValue([entry({ id: "a", ts: 1, decision: "deny" })])

    const snapshot = await readAutomationSupervision()

    expect(snapshot.enabled).toBe(false)
    expect(snapshot.killSwitchEngaged).toBe(true)
    expect(snapshot.defaultTier).toBe("perCall")
    expect(snapshot.counts).toEqual({ total: 1, allow: 0, deny: 1, consent: 0 })
  })

  /** The host ring is oldest-first. A supervisor wants the latest decision first. */
  it("turns the ring newest-first", async () => {
    auditSnapshot.mockResolvedValue([
      entry({ id: "old", ts: 100 }),
      entry({ id: "mid", ts: 200 }),
      entry({ id: "new", ts: 300 }),
    ])

    const snapshot = await readAutomationSupervision()

    expect(snapshot.recent.map((r) => r.id)).toEqual(["new", "mid", "old"])
  })

  it("caps the recent rows without narrowing the counts", async () => {
    auditSnapshot.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => entry({ id: `e${i}`, ts: i, decision: "deny" }))
    )

    const snapshot = await readAutomationSupervision(5)

    expect(snapshot.recent).toHaveLength(5)
    expect(snapshot.counts.total).toBe(40)
    expect(snapshot.counts.deny).toBe(40)
  })

  /**
   * One moment, not three. Reading these serially would let the view show a
   * running engine beside an audit list taken after it was halted.
   */
  it("reads state and history together", async () => {
    const order: string[] = []
    settingsGet.mockImplementation(async () => {
      order.push("settings")
      return { enabled: true, defaultTier: "off" }
    })
    killSwitchEngaged.mockImplementation(async () => {
      order.push("kill")
      return false
    })
    auditSnapshot.mockImplementation(async () => {
      order.push("audit")
      return []
    })

    await readAutomationSupervision()

    expect(order).toHaveLength(3)
    expect(settingsGet).toHaveBeenCalledTimes(1)
    expect(killSwitchEngaged).toHaveBeenCalledTimes(1)
    expect(auditSnapshot).toHaveBeenCalledTimes(1)
  })

  it("does not swallow a host that refuses the read", async () => {
    killSwitchEngaged.mockRejectedValue(new Error("remote_control_forbidden"))
    await expect(readAutomationSupervision()).rejects.toThrow("remote_control_forbidden")
  })
})

describe("haltAutomation", () => {
  it("engages the host kill switch", async () => {
    await haltAutomation()
    expect(killSwitch).toHaveBeenCalledTimes(1)
  })

  it("surfaces a refusal rather than reporting a halt that did not happen", async () => {
    killSwitch.mockRejectedValue(new Error("remote_control_forbidden"))
    await expect(haltAutomation()).rejects.toThrow("remote_control_forbidden")
  })
})
