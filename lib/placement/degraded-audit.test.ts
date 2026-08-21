import { recordPlacementDegraded } from "./degraded-audit"

const event = {
  reason: "authority_unreachable" as const,
  authorityHostId: "host-a",
  unreachableForMs: 600_000,
  at: 1_700_000_000_000,
}

describe("recordPlacementDegraded", () => {
  it("tells the user which host was skipped and why", () => {
    const notify = jest.fn(async () => "n1")
    return recordPlacementDegraded(event, { notify }).then(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "system",
          level: "warning",
          directed: true,
          body: expect.stringContaining("host-a"),
        })
      )
      expect(notify.mock.calls[0]![0].body).toContain("10 min")
    })
  })

  it("coalesces one episode instead of one notice per cron tick", async () => {
    // An authority that is down for a day would otherwise bury the center.
    const notify = jest.fn(async () => "n1")
    await recordPlacementDegraded(event, { notify })
    await recordPlacementDegraded({ ...event, at: event.at + 60_000 }, { notify })

    const keys = notify.mock.calls.map((call) => call[0].dedupeKey)
    expect(new Set(keys).size).toBe(1)
  })

  it("attaches the divergence to the run it affected", async () => {
    const appendRunEvent = jest.fn(async () => undefined)
    await recordPlacementDegraded(
      { ...event, runId: "run_1" },
      { notify: jest.fn(async () => "n"), appendRunEvent }
    )

    expect(appendRunEvent).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        type: "placement.degraded",
        reason: "authority_unreachable",
        authorityHostId: "host-a",
        unreachableForMs: 600_000,
      })
    )
  })

  it("distinguishes an authority that was never reachable from one that went away", async () => {
    const notify = jest.fn(async () => "n")
    await recordPlacementDegraded({ ...event, reason: "authority_unknown" }, { notify })
    expect(notify.mock.calls[0]![0].body).toContain("never connected")
  })

  it("never fails the work it is auditing", async () => {
    // The run already degraded once; failing it because the audit could not be
    // written would turn a visible degradation into an outage.
    const notify = jest.fn(async () => {
      throw new Error("notification store unavailable")
    })
    const appendRunEvent = jest.fn(async () => {
      throw new Error("dexie closed")
    })

    await expect(
      recordPlacementDegraded({ ...event, runId: "run_1" }, { notify, appendRunEvent })
    ).resolves.toBeUndefined()
  })

  it("skips the run log when the degrade happened outside a run", async () => {
    const appendRunEvent = jest.fn(async () => undefined)
    await recordPlacementDegraded(event, { notify: jest.fn(async () => "n"), appendRunEvent })
    expect(appendRunEvent).not.toHaveBeenCalled()
  })
})
